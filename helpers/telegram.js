import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { Account } from '../models/db.js';

/**
 * Create Telegram client from session string
 */
export function createClient(sessionString = '') {
  const apiId = parseInt(process.env.API_ID);
  const apiHash = process.env.API_HASH;
  const stringSession = new StringSession(sessionString);
  
  return new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });
}

/**
 * Helper function to get DC addresses
 */
function getDCAddress(dcId) {
  const dcMap = {
    1: "149.154.175.53",
    2: "149.154.167.51",
    3: "149.154.175.100",
    4: "149.154.167.91",
    5: "91.108.56.133",
  };
  return dcMap[dcId] || null;
}

/**
 * Send verification code with retry logic and DC migration handling
 */
export async function sendCodeWithRetry(client, phone, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt} to send code for ${phone}`);

      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: phone,
          apiId: parseInt(process.env.API_ID),
          apiHash: process.env.API_HASH,
          settings: new Api.CodeSettings({
            allowFlashcall: true,
            currentNumber: true,
            allowAppHash: true,
            allowMissedCall: true,
            logoutTokens: [Buffer.from("arbitrary data here")],
          }),
        })
      );

      console.log(`Code sent successfully for ${phone}`);
      return { success: true, phoneCodeHash: result.phoneCodeHash };
    } catch (error) {
      console.log(`Attempt ${attempt} failed:`, error.message);

      // Handle PHONE_MIGRATE error
      if (error.message && error.message.startsWith("PHONE_MIGRATE_")) {
        const dcId = parseInt(error.message.split("_").pop(), 10);
        console.log(`Phone requires DC ${dcId}, migrating...`);

        try {
          await client.disconnect();
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Create new client with correct DC
          const newClient = new TelegramClient(
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
              initialServerAddress: getDCAddress(dcId),
            }
          );

          await newClient.connect();

          // Retry with new client
          const result = await newClient.invoke(
            new Api.auth.SendCode({
              phoneNumber: phone,
              apiId: parseInt(process.env.API_ID),
              apiHash: process.env.API_HASH,
              settings: new Api.CodeSettings({
                allowFlashcall: true,
                currentNumber: true,
                allowAppHash: true,
                allowMissedCall: true,
                logoutTokens: [Buffer.from("arbitrary data here")],
              }),
            })
          );

          console.log(`Code sent successfully after DC migration for ${phone}`);
          
          // Return both client and phoneCodeHash
          return { 
            success: true, 
            phoneCodeHash: result.phoneCodeHash,
            client: newClient 
          };
        } catch (migrationError) {
          console.error(`Migration to DC ${dcId} failed:`, migrationError);
          if (attempt === maxRetries) {
            return {
              success: false,
              error: `Failed to migrate to DC ${dcId}: ${migrationError.message}`,
            };
          }
        }
      } else if (attempt === maxRetries) {
        return { success: false, error: error.message };
      }

      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

/**
 * Login to Telegram using stored phoneCodeHash and client
 */

export async function loginAccount(client, phoneNumber, phoneCodeHash, code, password = null) {
  try {
    let result;
    
    // If password is provided, skip SignIn and go straight to CheckPassword
    if (password) {
      console.log("Password provided, attempting 2FA login...");
      
      try {
        const passwordInfo = await client.invoke(
          new Api.account.GetPassword()
        );
        
        const { computeCheck } = await import('telegram/Password.js');
        const passwordHashResult = await computeCheck(
          passwordInfo,
          password
        );
        
        result = await client.invoke(
          new Api.auth.CheckPassword({
            password: passwordHashResult,
          })
        );
        
        return await handleSuccessfulLogin(result, client, phoneNumber);
        
      } catch (pwdError) {
        if (pwdError.errorMessage === 'PASSWORD_HASH_INVALID') {
          // DON'T disconnect - let them retry
          return {
            success: false,
            wrongPassword: true,
            error: 'Wrong password! Please try again.'
          };
        }
        throw pwdError;
      }
    }
    
    // No password provided, try normal sign in
    try {
      result = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: `${phoneNumber}`,
          phoneCodeHash: phoneCodeHash,
          phoneCode: code,
        })
      );
      
      return await handleSuccessfulLogin(result, client, phoneNumber);
      
    } catch (error) {
      if (
        error.code === 401 &&
        error.errorMessage === "SESSION_PASSWORD_NEEDED"
      ) {
        return {
          success: false,
          needsPassword: true
        };
      } else {
        throw error;
      }
    }
    
  } catch (error) {
    console.error('Login error:', error);
    
    try {
      await client.disconnect();
    } catch (e) {
      // Silently ignore disconnect errors
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}




/**
 * Handle successful login (extracted from your snippet logic)
 */
async function handleSuccessfulLogin(result, client, phoneNumber) {
  // Get user info
  const me = await client.getMe();
  const username = me.username;
  
  // Fetch groups
  const dialogs = await client.getDialogs({ limit: 500 });
  const groups = [];
  
  for (const dialog of dialogs) {
    const entity = dialog.entity;
    
    if (entity.className === 'Channel' || entity.className === 'Chat') {
      groups.push({
        id: entity.id.toString(),
        name: entity.title || 'Unnamed Group',
        link: entity.username ? `https://t.me/${entity.username}` : null,
        msgPerDay: 3,
        lastMessageId: 0
      });
    }
  }
  
  // Save session
  const sessionString = client.session.save();
  
  // Save to database
  const account = new Account({
    number: phoneNumber,
    username: username,
    session: sessionString,
    groups: groups,
    admin: false
  });
  
  await account.save();
  
  await client.disconnect();
  
  return {
    success: true,
    username: username,
    groupCount: groups.length
  };
}


/**
 * Login with 2FA password
 */
export async function loginWith2FA(client, password) {
  try {
    // Get password information
    const passwordInfo = await client.invoke(new Api.account.GetPassword());
    
    // Import password computation helper
    const { computeCheck } = await import('telegram/Password.js');
    
    // Compute password hash
    const passwordHash = await computeCheck(passwordInfo, password);
    
    // Check password
    await client.invoke(
      new Api.auth.CheckPassword({
        password: passwordHash
      })
    );
    
    // Get user info
    const me = await client.getMe();
    const username = me.username;
    const phoneNumber = me.phone;
    
    // Fetch groups
    const dialogs = await client.getDialogs({ limit: 500 });
    const groups = [];
    
    for (const dialog of dialogs) {
      const entity = dialog.entity;
      
      if (entity.className === 'Channel' || entity.className === 'Chat') {
        groups.push({
          id: entity.id.toString(),
          name: entity.title || 'Unnamed Group',
          link: entity.username ? `https://t.me/${entity.username}` : null,
          msgPerDay: 3,
          lastMessageId: 0
        });
      }
    }
    
    // Save session
    const sessionString = client.session.save();
    
    // Save to database
    const account = new Account({
      number: phoneNumber,
      username: username,
      session: sessionString,
      groups: groups,
      admin: false
    });
    
    await account.save();
    
    await client.disconnect();
    
    return {
      success: true,
      username: username,
      groupCount: groups.length
    };
    
  } catch (error) {
    console.error('2FA login error:', error);
    await client.disconnect();
    return {
      success: false,
      error: error.message
    };
  }
}


/**
 * Fetch all groups for a specific account
 */
export async function fetchAccountGroups(session) {
  const client = createClient(session);
  
  try {
    await client.connect();
    
    const dialogs = await client.getDialogs({ limit: 500 });
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
    
    await client.disconnect();
    return groups;
    
  } catch (error) {
    console.error('Error fetching groups:', error);
    await client.disconnect();
    return null;
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

const extractInviteHash = (link = '') => {
  if (!link) return null;
  // Examples: https://t.me/+HASH , https://t.me/joinchat/HASH
  const m1 = link.match(/t\.me\/\+([a-zA-Z0-9_-]+)/);
  if (m1?.[1]) return m1[1];
  const m2 = link.match(/t\.me\/joinchat\/([a-zA-Z0-9_-]+)/);
  if (m2?.[1]) return m2[1];
  return null;
};

/**
 * Join a group/channel by public username link or invite hash link.
 */
export async function joinGroup(session, linkOrUsername) {
  const client = createClient(session);
  try {
    await client.connect();

    const inviteHash = extractInviteHash(linkOrUsername);
    if (inviteHash) {
      await client.invoke(
        new Api.messages.ImportChatInvite({
          hash: inviteHash,
        })
      );
      await client.disconnect();
      return true;
    }

    const username = extractUsernameFromLink(linkOrUsername) || (linkOrUsername || '').replace('@', '').trim();
    if (!username) {
      await client.disconnect();
      return false;
    }

    const entity = await client.getEntity(username);
    // Works for channels/supergroups
    await client.invoke(new Api.channels.JoinChannel({ channel: entity }));

    await client.disconnect();
    return true;
  } catch (error) {
    try { await client.disconnect(); } catch {}
    console.error('Error joining group:', error?.message || error);
    return false;
  }
}

/**
 * Leave a specific group
 */
export async function leaveGroup(session, groupId) {
  const client = createClient(session);
  
  try {
    await client.connect();
    
    const dialogs = await client.getDialogs({ limit: 500 });
    const targetDialog = dialogs.find(d => d.entity.id.toString() === groupId);
    
    if (!targetDialog) {
      await client.disconnect();
      return false;
    }
    
    await client.invoke(
      new Api.channels.LeaveChannel({
        channel: targetDialog.entity
      })
    );
    
    await client.disconnect();
    return true;
    
  } catch (error) {
    console.error('Error leaving group:', error);
    await client.disconnect();
    return false;
  }
}

// export { createClient, loginAccount, fetchAccountGroups, leaveGroup, sendCodeWithRetry };
