import { Markup } from 'telegraf';
import { Account, AdminWithoutSessions, System } from '../models/db.js';
import { loginAccount, createClient, sendCodeWithRetry, loginWith2FA } from './telegram.js';
import { fetchAllAccountGroups, handleDuplicateGroups, findAdminOnlyGroups, syncAdminGroupsAndDistribute } from './groupManager.js';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';

// Session storage for multi-step conversations
const userSessions = new Map();

// Global client storage for authentication
let authClient = null;

async function isAdminUserId(userId) {
  const id = userId?.toString();
  if (!id) return false;
  const accountAdmin = await Account.findOne({ admin: true, adminUserId: id });
  if (accountAdmin) return true;
  const adminNoSession = await AdminWithoutSessions.findOne({ userId: id });
  return !!adminNoSession;
}

export function getUserSession(userId) {
  return userSessions.get(userId);
}

export function clearUserSession(userId) {
  userSessions.delete(userId);
}

/**
 * Main menu markup
 */
function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📋 All Accounts', 'all_accounts')],
    [Markup.button.callback('➕ Add Account', 'add_account')],
    [Markup.button.callback('🔄 Refresh Groups', 'refresh_groups')],
    [Markup.button.callback('⚙️ Set Report Channel', 'set_report_channel')],
    [Markup.button.callback('🔊 Start Preaching', 'start_preaching')],
    [Markup.button.callback('🔇 Stop Preaching', 'stop_preaching')],
    [Markup.button.callback('🔄 Restart Monitoring', 'restart_monitoring')]
  ]);
}

/**
 * Handle /start command
 */
export async function handleStart(ctx) {
    console.log("...")
  const welcomeText = '👋 *Welcome to Dev Preacher Bot*\n\n' +
    'Use the buttons below to operate me:';
  
  if (ctx.callbackQuery) {
    await ctx.editMessageText(welcomeText, {
      parse_mode: 'Markdown',
      ...getMainMenu()
    });
    await ctx.answerCbQuery();
  } else {
    await ctx.reply(welcomeText, {
      parse_mode: 'Markdown',
      ...getMainMenu()
    });
  }
}

/**
 * Handle "All Accounts" button
 */
export async function handleAllAccounts(ctx) {
  try {
    const accounts = await Account.find({}).sort({ createdAt: 1 });
    
    if (accounts.length === 0) {
      await ctx.editMessageText(
        '❌ No accounts found in database.',
        Markup.inlineKeyboard([
          [Markup.button.callback('« Back', 'back_to_main')]
        ])
      );
      await ctx.answerCbQuery();
      return;
    }
    
    // Format account list
    let accountList = '📋 *All Accounts*\n\n';
    accounts.forEach((acc, index) => {
      const username = acc.username ? `@${acc.username}` : acc.number;
      const groupCount = acc.groups ? acc.groups.length : 0;
      const adminBadge = acc.admin ? '👑 ' : '';
      accountList += `${index + 1}. ${adminBadge}${username}, ${groupCount} groups\n`;
    });
    
    await ctx.editMessageText(accountList, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'back_to_main')]
      ])
    });
    await ctx.answerCbQuery();
    
  } catch (error) {
    console.error('Error fetching accounts:', error);
    await ctx.answerCbQuery('❌ Error fetching accounts');
  }
}



export async function handleAddAccount(ctx) {
  // Only admins can login/add accounts
  if (!(await isAdminUserId(ctx.from.id))) {
    await ctx.answerCbQuery();
    await ctx.reply('Not allowed.');
    return;
  }

  const userId = ctx.from.id;
  
  userSessions.set(userId, {
    step: 'awaiting_account_type',
    data: {}
  });
  
  await ctx.editMessageText(
    '📱 *Add New Account*\n\n' +
    'Should this account be an *admin* account or a normal (non-admin) account?\n\n' +
    'Admin accounts are not used for preaching; they are used for managing groups and admin actions.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👑 Admin account', 'add_account_admin')],
        [Markup.button.callback('👤 Non-admin account', 'add_account_nonadmin')],
        [Markup.button.callback('« Cancel', 'back_to_main')]
      ])
    }
  );
  await ctx.answerCbQuery();
}

export async function handleAddAccountAdmin(ctx) {
  if (!(await isAdminUserId(ctx.from.id))) {
    await ctx.answerCbQuery();
    await ctx.reply('Not allowed.');
    return;
  }

  const userId = ctx.from.id;
  const session = getUserSession(userId) || { step: 'awaiting_number', data: {} };
  session.step = 'awaiting_number';
  session.data = { ...(session.data || {}), isAdminAccount: true };
  userSessions.set(userId, session);

  await ctx.editMessageText(
    '📱 *Add Admin Account*\n\n' +
    'Please send the phone number (with country code):\n' +
    'Example: +1234567890',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Cancel', 'back_to_main')]
      ])
    }
  );
  await ctx.answerCbQuery();
}

export async function handleAddAccountNonAdmin(ctx) {
  if (!(await isAdminUserId(ctx.from.id))) {
    await ctx.answerCbQuery();
    await ctx.reply('Not allowed.');
    return;
  }

  const userId = ctx.from.id;
  const session = getUserSession(userId) || { step: 'awaiting_number', data: {} };
  session.step = 'awaiting_number';
  session.data = { ...(session.data || {}), isAdminAccount: false };
  userSessions.set(userId, session);

  await ctx.editMessageText(
    '📱 *Add Non-admin Account*\n\n' +
    'Please send the phone number (with country code):\n' +
    'Example: +1234567890',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Cancel', 'back_to_main')]
      ])
    }
  );
  await ctx.answerCbQuery();
}

export async function handlePhoneNumber(ctx, session) {
  if (!(await isAdminUserId(ctx.from.id))) {
    clearUserSession(ctx.from.id);
    return ctx.reply('Not allowed.');
  }
  const phoneNumber = ctx.message.text.trim();
  
  await ctx.reply('⏳ Sending verification code...');
  
  try {
    // Create client with better configuration
    authClient = new TelegramClient(
      new StringSession(""),
      parseInt(process.env.API_ID),
      process.env.API_HASH,
      {
        useWSS: false,
        autoReconnect: true,
        timeout: 30000,
        requestRetries: 3,
        connectionRetries: 5,
        retryDelay: 1000,
        maxConcurrentDownloads: 1,
      }
    );

    console.log(`Attempting to connect for phone: ${phoneNumber}`);
    await authClient.connect();
    console.log("Client connected successfully");

    // Send code with better error handling
    const result = await sendCodeWithRetry(authClient, phoneNumber);

    if (result.success) {
      // Store phoneCodeHash and client in session
      session.data.phoneNumber = phoneNumber;
      session.data.phoneCodeHash = result.phoneCodeHash;
      session.data.client = result.client || authClient; // Use migrated client if available
      session.step = 'awaiting_code';
      
      // Store globally as well
      authClient = result.client || authClient;
      
      await ctx.reply(
        '🔐 Verification code sent to your phone!\n\n' +
        'Please send the code:',
        Markup.inlineKeyboard([
          [Markup.button.callback('« Cancel', 'back_to_main')]
        ])
      );
    } else {
      throw new Error(result.error);
    }
    
  } catch (error) {
    console.error('Error sending code:', error);
    clearUserSession(ctx.from.id);
    
    if (error.message.includes("PHONE_NUMBER_BANNED")) {
      await ctx.reply(`❌ *Number is BANNED. Login another number.*`);
    } else {
      await ctx.reply(
        `❌ *Error sending code*\n\n` +
        `Error: ${error.message}`,
        { parse_mode: 'Markdown', ...getMainMenu() }
      );
    }
  }
}



export async function handleVerificationCode(ctx, session) {
  if (!(await isAdminUserId(ctx.from.id))) {
    clearUserSession(ctx.from.id);
    return ctx.reply('Not allowed.');
  }
  const userId = ctx.from.id;
  const code = ctx.message.text.trim();
  const phoneNumber = session.data.phoneNumber;
  const phoneCodeHash = session.data.phoneCodeHash;
  
  console.log(code, phoneNumber, phoneCodeHash)
  
  await ctx.reply('⏳ Logging in...');
  
  try {
    // Use the global authClient that sent the code
    if (!authClient || !authClient.connected) {
      console.log('Auth client disconnected, reconnecting...');
      await authClient.connect();
    }
    
    let result;
    try {
      // Attempt to sign in using the code with the SAME global client
      result = await authClient.invoke(
        new Api.auth.SignIn({
          phoneNumber: `${phoneNumber}`,
          phoneCodeHash: phoneCodeHash,
          phoneCode: code,
        })
      );

      await handleSuccessfulLogin(result, ctx, phoneNumber);
    } catch (error) {
      if (
        error.code === 401 &&
        error.errorMessage === "SESSION_PASSWORD_NEEDED"
      ) {
        session.step = 'awaiting_password';
        session.data.code = code;
        await ctx.reply(
          '🔒 Two-factor authentication is enabled.\n\n' +
          'Please send your password:',
          Markup.inlineKeyboard([
            [Markup.button.callback('« Cancel', 'back_to_main')]
          ])
        );
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('Error during verification:', error);
    clearUserSession(userId);
    await ctx.reply(
      `❌ *Login failed*\n\n` +
      `Error: ${error.message}`,
      { parse_mode: 'Markdown', ...getMainMenu() }
    );
  }
}



export async function handlePassword(ctx, session) {
  if (!(await isAdminUserId(ctx.from.id))) {
    clearUserSession(ctx.from.id);
    return ctx.reply('Not allowed.');
  }
  const userId = ctx.from.id;
  const password = ctx.message.text.trim();
  const phoneNumber = session.data.phoneNumber;
  
  await ctx.reply('⏳ Verifying password...');
  
  try {
    console.log("Password provided, attempting 2FA login...");
    
    // Handle 2FA authentication using global authClient
    const passwordInfo = await authClient.invoke(
      new Api.account.GetPassword()
    );
    
    const { computeCheck } = await import('telegram/Password.js');
    const passwordHashResult = await computeCheck(
      passwordInfo,
      password
    );

    const result = await authClient.invoke(
      new Api.auth.CheckPassword({
        password: passwordHashResult,
      })
    );

    await handleSuccessfulLogin(result, ctx, phoneNumber);
    
  } catch (error) {
    console.error('Error during password verification:', error);
    
    if (error.errorMessage === 'PASSWORD_HASH_INVALID') {
      await ctx.reply(
        `❌ *Wrong password!*\n\nPlease try again:`,
        { 
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('« Cancel', 'back_to_main')]
          ])
        }
      );
      return;
    }
    
    clearUserSession(userId);
    await ctx.reply(
      `❌ *Login failed*\n\n` +
      `Error: ${error.message}`,
      { parse_mode: 'Markdown', ...getMainMenu() }
    );
  }
}

// Helper function to handle successful login
async function handleSuccessfulLogin(result, ctx, phoneNumber) {
  const userId = ctx.from.id;
  
  if (!authClient) {
    throw new Error('Auth client not found');
  }

  // Get user info
  const me = await authClient.getMe();
  const username = me.username;

  const loginSession = getUserSession(userId);
  const isAdminAccount = !!loginSession?.data?.isAdminAccount;
  
  // Fetch groups
  const dialogs = await authClient.getDialogs({ limit: 500 });
  const groups = [];
  
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    
    if (entity.className === 'Channel' || entity.className === 'Chat') {
      groups.push({
        id: entity.id.toString(),
        name: entity.title || 'Unnamed Group',
        link: entity.username ? `https://t.me/${entity.username}` : null,
        msgPerDay: 5,
        lastMessageId: 0
      });
    }
  }
  
  // Save session
  const sessionString = authClient.session.save();
  
  // Save to database
  const account = new Account({
    number: phoneNumber,
    username: username,
    session: sessionString,
    groups: groups,
    admin: isAdminAccount,
    ...(isAdminAccount ? { adminUserId: ctx.from.id.toString() } : {}),
    currentMessageId: 0 // Initialize account-level message ID
  });
  
  await account.save();
  
  await authClient.disconnect();
  
  // Clear global auth client
  authClient = null;
  
  // Clear user session
  clearUserSession(ctx.from.id);
  
  // Restart message monitoring to include the new account
  try {
    const { restartMonitoring } = await import('./messageMonitor.js');
    await restartMonitoring();
    console.log('✅ Message monitoring restarted for new account');
  } catch (error) {
    console.error('❌ Error restarting message monitoring:', error);
  }
  
  await ctx.reply(
    `✅ *Account added successfully!*\n\n` +
    `Username: ${username || 'N/A'}\n` +
    `Groups: ${groups.length}`,
    { parse_mode: 'Markdown', ...getMainMenu() }
  );
}

/**
 * Handle "Refresh Groups" button
 */
export async function handleRefreshGroups(ctx) {
  await ctx.answerCbQuery();
  await ctx.editMessageText('⏳ Refreshing groups... This may take a while.');
  
  try {
    // Step 1: Sync admin groups and distribute new ones to non-admin accounts
    const distribution = await syncAdminGroupsAndDistribute();

    // Step 2: Fetch and update all account groups (keeps DB aligned with reality)
    await fetchAllAccountGroups();

    // Step 3: Optional: remove duplicate memberships among non-admin accounts
    await handleDuplicateGroups();

    // Step 4: Find admin-only groups (should be minimized by distribution)
    const adminOnlyGroups = await findAdminOnlyGroups();
    
    // Format response
    let responseText = '✅ *Groups refreshed successfully!*\n\n';

    responseText += `*New admin groups found:* ${distribution.newGroups}\n`;
    responseText += `*Assigned to non-admins:* ${distribution.assigned}\n`;
    responseText += `*Failed assignments:* ${distribution.failed}\n\n`;
    
    if (adminOnlyGroups.length > 0) {
      responseText += '*The devs aren\'t here:*\n\n';
      adminOnlyGroups.forEach(group => {
        responseText += `${group.link || group.name}\n`;
      });
    } else {
      responseText += 'All groups have at least one non-admin member.';
    }
    
    await ctx.editMessageText(responseText, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'back_to_main')]
      ])
    });
    
  } catch (error) {
    console.error('Error refreshing groups:', error);
    await ctx.editMessageText(
      '❌ Error refreshing groups. Please try again.',
      Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'back_to_main')]
      ])
    );
  }
}

/**
 * Handle "Set Report Channel" button
 */
export async function handleSetReportChannel(ctx) {
  const userId = ctx.from.id;
  
  userSessions.set(userId, {
    step: 'awaiting_channel',
    data: {}
  });
  
  await ctx.editMessageText(
    '📢 *Set Report Channel*\n\n' +
    'Please send the channel username:\n' +
    'Example: @mychannel or mychannel',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('« Cancel', 'back_to_main')]
      ])
    }
  );
  await ctx.answerCbQuery();
}

export async function handleChannelUsername(ctx, session) {
  const userId = ctx.from.id;
  let channelUsername = ctx.message.text.trim();
  
  if (!channelUsername.startsWith('@')) {
    channelUsername = '@' + channelUsername;
  }
  
  try {
    let systemDoc = await System.findOne({});
    
    if (!systemDoc) {
      systemDoc = new System({ reportChannel: channelUsername });
      await systemDoc.save();
    } else {
      systemDoc.reportChannel = channelUsername;
      await systemDoc.save();
    }
    
    clearUserSession(userId);
    
    await ctx.reply(
      `✅ *Report channel set successfully!*\n\n` +
      `Channel: ${channelUsername}`,
      { parse_mode: 'Markdown', ...getMainMenu() }
    );
    
  } catch (error) {
    console.error('Error setting report channel:', error);
    clearUserSession(userId);
    
  await ctx.reply(
    '❌ Error setting report channel. Please try again.',
    getMainMenu()
  );
}
}

/**
 * Handle "Restart Monitoring" button
 */
export async function handleRestartMonitoring(ctx) {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🔄 Restarting message monitoring...');
  
  try {
    const { restartMonitoring } = await import('./messageMonitor.js');
    await restartMonitoring();
    
    await ctx.editMessageText(
      '✅ Message monitoring restarted successfully!',
      Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'back_to_main')]
      ])
    );
    
  } catch (error) {
    console.error('Error restarting monitoring:', error);
    await ctx.editMessageText(
      '❌ Error restarting message monitoring. Please try again.',
      Markup.inlineKeyboard([
        [Markup.button.callback('« Back', 'back_to_main')]
      ])
    );
  }
}