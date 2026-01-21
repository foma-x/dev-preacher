import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { Account, AdminWithoutSessions, Customer, FinderMessage, System } from '../models/db.js';

// Global storage for active monitoring clients
let monitoringClients = new Map();
let reconnectIntervals = new Map();

// Create Telegram client for monitoring
function createMonitoringClient(session) {
  const apiId = parseInt(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  const stringSession = new StringSession(session);

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    timeout: 30000,
    requestRetries: 3,
    autoReconnect: true,
  });

  // Suppress logs
  client.setLogLevel('none');

  return client;
}

// Send notification to admin
const truncate50 = (text = '') => {
  const cleaned = (text || '').toString().replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 750) return cleaned;
  return `${cleaned.slice(0, 747)}...`;
};

async function getAdminUserIds() {
  const userIds = new Set();

  const adminAccounts = await Account.find({ admin: true, adminUserId: { $ne: null } }, { adminUserId: 1 });
  for (const acc of adminAccounts) {
    if (acc.adminUserId) userIds.add(acc.adminUserId.toString());
  }

  const adminsNoSessions = await AdminWithoutSessions.find({}, { userId: 1 });
  for (const admin of adminsNoSessions) {
    if (admin.userId) userIds.add(admin.userId.toString());
  }

  return Array.from(userIds);
}

async function notifyAdmins(message, extra = {}) {
  try {
    if (!global.bot) return;

    const adminUserIds = await getAdminUserIds();
    if (adminUserIds.length === 0) return;

    await Promise.allSettled(
      adminUserIds.map((userId) =>
        global.bot.telegram.sendMessage(userId, message, extra)
      )
    );
  } catch (error) {
    console.error('❌ Error sending admin notification:', error);
  }
}

const extractUsernameFromLink = (link = '') => {
  if (!link) return null;
  let normalized = link.trim();
  normalized = normalized.replace(/^https?:\/\//i, '');
  normalized = normalized.replace(/^t\.me\//i, '');
  normalized = normalized.replace(/^telegram\.me\//i, '');
  normalized = normalized.split('/')[0];
  normalized = normalized.split('?')[0];
  normalized = normalized.replace('@', '').trim();
  return normalized || null;
};

const buildMessageLink = async (client, message) => {
  try {
    const chat = await message.getChat();
    if (chat?.username) {
      return `https://t.me/${chat.username}/${message.id}`;
    }

    const chatIdStr = (message.chatId || chat?.id)?.toString?.() || '';
    if (chatIdStr.startsWith('-100')) {
      return `https://t.me/c/${chatIdStr.slice(4)}/${message.id}`;
    }
    if (chatIdStr.startsWith('-')) {
      return `https://t.me/c/${chatIdStr.slice(1)}/${message.id}`;
    }
    return '';
  } catch {
    return '';
  }
};

async function getDumpGroupId() {
  const doc = await System.findOne({}, { dumpGroupId: 1 });
  return doc?.dumpGroupId || null;
}

const FINDING_KEYWORDS = [
  'web', 'website', 'dev', 'developer', 'bot', 'software', 'engineer',
  'programmer', 'build', 'develop', 'clone'
];

const containsFindingKeyword = (text = '') => {
  const lower = (text || '').toLowerCase();
  return FINDING_KEYWORDS.some((k) => lower.includes(k));
};

// Reconnect monitoring for a specific account
async function reconnectMonitoring(account, accountUsername) {
  try {
    console.log(`🔄 Reconnecting monitoring for ${accountUsername}...`);
    
    // Stop existing monitoring for this account
    const existing = monitoringClients.get(account.number);
    if (existing && existing.client) {
      try {
        if (existing.client.connected) {
          await existing.client.disconnect();
        }
      } catch (e) {
        // Ignore disconnect errors
      }
    }

    // Clear any existing reconnect interval
    if (reconnectIntervals.has(account.number)) {
      clearInterval(reconnectIntervals.get(account.number));
      reconnectIntervals.delete(account.number);
    }

    // Wait a bit before reconnecting
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Start monitoring again
    await startMonitoringAccount(account);

  } catch (error) {
    console.error(`❌ Error reconnecting ${accountUsername}:`, error);
  }
}

// Start monitoring for a single account
async function startMonitoringAccount(account) {
  try {
    const client = createMonitoringClient(account.session);
    await client.connect();

    // Get account username
    const me = await client.getMe();
    const accountUsername = me.username ? `@${me.username}` : account.number;

    monitoringClients.set(account.number, { client, username: accountUsername });

    console.log(`✅ Monitoring started for admin account: ${accountUsername}`);

    // Set up disconnect handler
    client.addEventHandler(async (update) => {
      if (update.className === 'UpdateConnectionState') {
        console.log(`⚠️ Connection state changed for ${accountUsername}`);
        
        // If disconnected, try to reconnect after delay
        if (!client.connected) {
          console.log(`❌ ${accountUsername} disconnected - scheduling reconnect`);
          setTimeout(() => {
            reconnectMonitoring(account, accountUsername);
          }, 10000);
        }
      }
    });

    client.addEventHandler(
      async (event) => {
        try {
          const message = event.message;

          // Skip our own messages
          if (message.out) return;

          const sender = await message.getSender();
          const username = sender.username ? `@${sender.username}` : 'No username';
          const userId = sender.id.toString();
          const content = message.text || '[Media message]';

          // Handle DMs to admin accounts
          if (event.isPrivate) {
            // Check if customer already exists
            const existingCustomer = await Customer.findOne({ userId: userId });

            if (!existingCustomer) {
              // First message - save and notify
              const customer = new Customer({
                username: username,
                userId: userId,
                textedAt: new Date(),
                type: 'dm',
                content: content,
                senderAccount: account.number,
              });

              await customer.save();

              // Send notification to admin
              const notificationMessage = `📩 New DM to ${accountUsername}\n\nFrom: ${username} | ID: ${userId}\n\nMessage: ${truncate50(content)}`;
              await notifyAdmins(notificationMessage);
            }
            return;
          }

          // Group replies to admin account messages => notify admins
          if (event.isGroup && message.replyTo && message.replyTo.replyToMsgId) {
            try {
              const chat = await message.getChat();
              const repliedToMsg = await client.getMessages(message.peerId, { ids: [message.replyTo.replyToMsgId] });

              if (repliedToMsg && repliedToMsg[0] && repliedToMsg[0].out) {
                const existingCustomer = await Customer.findOne({ userId: userId });
                if (!existingCustomer) {
                  const customer = new Customer({
                    username: username,
                    userId: userId,
                    textedAt: new Date(),
                    type: 'reply',
                    content: content,
                    senderAccount: account.number,
                    groupId: chat?.id?.toString?.() || null,
                  });
                  await customer.save();
                }

                const link = await buildMessageLink(client, message);
                const groupName = chat?.title || 'Unknown Group';
                const notificationMessage = `📩 New reply to ${accountUsername}\n\nFrom: ${username} | ID: ${userId}\n\nGroup: ${groupName}\nLink: ${link}\n\nMessage: ${truncate50(content)}`;
                await notifyAdmins(notificationMessage, { disable_web_page_preview: true });
                return;
              }
            } catch (e) {
              // ignore reply-check errors
            }
          }

          // ==========================================
          // KEYWORD DETECTION (FINDER MODE)
          // This is the main feature - detect keywords in group messages
          // ==========================================
          if (event.isGroup && !event.isPrivate) {
            const dumpGroupId = await getDumpGroupId();
            if (!dumpGroupId) {
              // No dump group configured - skip keyword detection
              return;
            }

            // Skip if no text content
            if (!content || content === '[Media message]') return;

            // Check for keywords
            if (!containsFindingKeyword(content)) return;

            // Only save if sender not in Customer collection already
            const existingCustomer = await Customer.findOne({ userId: userId });
            if (existingCustomer) return;

            // Build message link
            const link = await buildMessageLink(client, message);
            if (!link) return;

            console.log(`🔍 Keyword detected in message from ${username}`);

            // Save customer as finding-a-dev
            const customer = new Customer({
              username: username,
              userId: userId,
              textedAt: new Date(),
              type: 'finding-a-dev',
              content: truncate50(content),
              senderAccount: account.number,
              groupId: (message.chatId || '').toString?.() || null,
            });
            await customer.save();

            // Send to dump group with proper format and button
            const chat = await message.getChat();
            const groupName = chat?.title || 'Unknown Group';
            
            const dumpText =
              `From: ${username} | ID: ${userId}\n` +
              `Group: ${groupName}\n\n` +
              `Message: ${truncate50(content)}\n\n` +
              `Link: ${link}\n\n` +
              `Click "Completed" when done`;

            const sent = await global.bot.telegram.sendMessage(
              dumpGroupId,
              dumpText,
              {
                disable_web_page_preview: true,
                reply_markup: {
                  inline_keyboard: [[{ text: '✅ Completed', callback_data: 'finder_done_pending' }]],
                },
              }
            );

            // Store finder message in DB and then edit button callback to include id
            const finder = await FinderMessage.create({
              dumpGroupId: dumpGroupId.toString(),
              dumpMessageId: sent.message_id,
              sourceChatId: (message.chatId || '').toString(),
              sourceMessageId: message.id,
              sourceLink: link,
              senderUserId: userId,
              preview: truncate50(content),
            });

            // Update button with actual finder ID
            await global.bot.telegram.editMessageReplyMarkup(
              dumpGroupId,
              sent.message_id,
              undefined,
              { inline_keyboard: [[{ text: '✅ Completed', callback_data: `finder_done:${finder._id.toString()}` }]] }
            );

            console.log(`✅ Forwarded to dump group: ${dumpGroupId}`);
          }
        } catch (error) {
          console.error(`Error processing message for ${accountUsername}:`, error);
          // Don't let individual message errors crash the entire monitoring
        }
      },
      new NewMessage({ incoming: true })
    );

    // Set up periodic health check
    const healthCheckInterval = setInterval(async () => {
      try {
        if (!client.connected) {
          console.log(`⚠️ Health check failed for ${accountUsername} - reconnecting`);
          clearInterval(healthCheckInterval);
          reconnectMonitoring(account, accountUsername);
        }
      } catch (error) {
        console.error(`Health check error for ${accountUsername}:`, error);
        clearInterval(healthCheckInterval);
        reconnectMonitoring(account, accountUsername);
      }
    }, 5 * 60 * 1000); // Check every 5 minutes

    // Store health check interval
    reconnectIntervals.set(account.number, healthCheckInterval);

  } catch (error) {
    const errorMsg = error?.errorMessage || error?.message || '';
    const errorCode = error?.code;
    
    console.error(`❌ Error starting monitoring for account ${account.number}:`, error);
    
    // Retry after delay if initial connection fails
    setTimeout(() => {
      console.log(`🔄 Retrying monitoring for ${account.number}...`);
      startMonitoringAccount(account);
    }, 30000);
  }
}

// Start monitoring for all ADMIN accounts
export async function startMessageMonitoring() {
  try {
    // ========================================
    // KEY CHANGE: Use admin accounts instead of non-admin accounts
    // ========================================
    const accounts = await Account.find({ admin: true });

    if (accounts.length === 0) {
      console.log('ℹ️ No admin accounts found for monitoring');
      console.log('⚠️ Please add at least one admin account to enable keyword detection');
      return;
    }

    console.log(`🚀 Starting message monitoring with ${accounts.length} admin account(s)...`);

    for (const account of accounts) {
      await startMonitoringAccount(account);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log(`✅ Message monitoring started for ${accounts.length} admin account(s)`);

  } catch (error) {
    console.error('❌ Error starting message monitoring:', error);
  }
}

// Stop monitoring for all accounts
export async function stopMessageMonitoring() {
  try {
    // Clear all health check intervals
    for (const interval of reconnectIntervals.values()) {
      clearInterval(interval);
    }
    reconnectIntervals.clear();

    const disconnectPromises = Array.from(monitoringClients.values()).map(async (clientData) => {
      try {
        const client = clientData.client || clientData;
        if (client && client.connected) {
          await client.disconnect();
        }
      } catch (error) {
        // Silently handle disconnect errors
      }
    });

    await Promise.allSettled(disconnectPromises);
    monitoringClients.clear();

    console.log('✅ Message monitoring stopped');

  } catch (error) {
    console.error('❌ Error stopping message monitoring:', error);
  }
}

// Restart monitoring when new accounts are added
export async function restartMonitoring() {
  await stopMessageMonitoring();
  await new Promise(resolve => setTimeout(resolve, 3000));
  await startMessageMonitoring();
}