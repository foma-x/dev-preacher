import {
  handleStart,
  handleAllAccounts,
  handleAddAccount,
  handleAddAccountAdmin,
  handleAddAccountNonAdmin,
  handleRefreshGroups,
  handleSetReportChannel,
  handleRestartMonitoring,
  getUserSession,
  handlePhoneNumber,
  handleVerificationCode,
  handlePassword,
  handleChannelUsername,
} from "./helpers/botHandlers.js";
import dotenv from "dotenv";
import { Telegraf } from "telegraf";
import { connectDB } from "./models/db.js";
import { Account, AdminWithoutSessions, FinderMessage, System } from "./models/db.js";
import { startPreaching, stopPreaching } from "./helpers/preaching.js";
import { startMessageMonitoring, stopMessageMonitoring } from "./helpers/messageMonitor.js";
import launchBot from "./helpers/launchbot.js";
import express from "express";
dotenv.config();

const app = express();
const bot = new Telegraf(process.env.BOT_TOKEN);
global.bot = bot;

async function isAdminUserId(userId) {
  const id = userId?.toString();
  if (!id) return false;

  // Auth strictly via DB: admin Accounts or AdminWithoutSessions
  const accountAdmin = await Account.findOne({ admin: true, adminUserId: id });
  if (accountAdmin) return true;

  const adminNoSession = await AdminWithoutSessions.findOne({ userId: id });
  return !!adminNoSession;
}

async function ensureSystemDoc() {
  let doc = await System.findOne({});
  if (!doc) {
    doc = new System({});
    await doc.save();
  }
  return doc;
}

app.get("/ping", (req, res) => {
  res.send("Pong");
});

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log("Server is running on port ", PORT);
});

bot.start(handleStart)
bot.action("all_accounts", handleAllAccounts);
bot.action("add_account", handleAddAccount);
bot.action("add_account_admin", handleAddAccountAdmin);
bot.action("add_account_nonadmin", handleAddAccountNonAdmin);
bot.action("refresh_groups", handleRefreshGroups);
bot.action("set_report_channel", handleSetReportChannel);
bot.action("start_preaching", startPreaching)
bot.action("stop_preaching", stopPreaching)
bot.action("restart_monitoring", handleRestartMonitoring)

// Back button navigation
bot.action("back_to_main", async (ctx) => {
  await handleStart(ctx);
});

// Callback query handlers
bot.action("all_accounts", handleAllAccounts);
bot.action(/^back_to_/, async (ctx) => {
  // Handle back button navigation
  const targetMenu = ctx.match[0].split("back_to_")[1];

  if (targetMenu === "main") {
    await handleStart(ctx);
  } else if (targetMenu === "accounts") {
    await handleAllAccounts(ctx);
  }
});

bot.action("add_account", handleAddAccount);
bot.action("refresh_groups", handleRefreshGroups);
bot.action("set_report_channel", handleSetReportChannel);




// Admin commands
bot.command("whoami", async (ctx) => {
  const id = ctx.from.id.toString();
  const username = ctx.from.username ? `@${ctx.from.username}` : 'none';
  await ctx.reply(`id: ${id}\nusername: ${username}`);
});
bot.command("groupid", async (ctx) => {
  // Only meaningful in groups/supergroups/channels
  const chatType = ctx.chat?.type;
  if (!chatType || (chatType !== "group" && chatType !== "supergroup" && chatType !== "channel")) {
    return ctx.reply("Use this command inside a group.");
  }

  const chatId = ctx.chat?.id?.toString?.() || "";
  return ctx.reply(chatId ? `Group ID: ${chatId}` : "Could not read group id.");
});


// Add this function at the top
// function ensureMinus100(groupId) {
//   const idStr = groupId.toString().trim().replace(/\s+/g, '');
  
//   // If already starts with -100, return as is
//   if (idStr.startsWith('-100')) return idStr;
  
//   // Remove any existing minus sign
//   const cleanId = idStr.replace(/^-/, '');
  
//   // Always prepend -100 for storage
//   return `-100${cleanId}`;
// }

// Update your set_dump command
// bot.command("set_dump", async (ctx) => {
//   if (!(await isAdminUserId(ctx.from.id))) return ctx.reply("Not allowed.");
  
//   const parts = (ctx.message.text || "").trim().split(/\s+/);
//   const groupId = parts[1];
//   if (!groupId) return ctx.reply("Usage: /set_dump {groupId}");
  
//   const normalizedId = ensureMinus100(groupId);
  
//   const doc = await ensureSystemDoc();
//   doc.dumpGroupId = normalizedId;
//   await doc.save();
  
//   await ctx.reply(`✅ Dump group set to: ${normalizedId}`);
// });

// SIMPLE FIX: Remove the ensureMinus100 function completely
bot.command("set_dump", async (ctx) => {
  if (!(await isAdminUserId(ctx.from.id))) return ctx.reply("Not allowed.");
  
  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const groupId = parts[1];
  if (!groupId) return ctx.reply("Usage: /set_dump {groupId}");
  
  // Store EXACTLY what was provided
  const doc = await ensureSystemDoc();
  doc.dumpGroupId = groupId.toString().trim();
  await doc.save();
  
  await ctx.reply(`✅ Dump group set to: ${doc.dumpGroupId}`);
});

bot.command("set_admin", async (ctx) => {
  if (!(await isAdminUserId(ctx.from.id))) {
    return;
  }

  const parts = (ctx.message.text || "").trim().split(/\s+/);
  const arg = parts[1];
  if (!arg) {
    return ctx.reply("Usage: /set_admin {username|userId}");
  }

  const isNumeric = /^\d+$/.test(arg);
  let username = null;
  let userId = null;

  if (isNumeric) {
    userId = arg;
  } else {
    username = arg.replace("@", "").trim();
    // Try resolving userId via Bot API
    try {
      const chat = await bot.telegram.getChat(`@${username}`);
      userId = chat?.id?.toString?.() || null;
    } catch {
      // leave userId null if cannot resolve
    }
  }

  // If an Account exists with that username, mark it admin and store adminUserId if we have it
  let updated = false;
  if (username) {
    const acc = await Account.findOne({ username });
    if (acc) {
      await Account.updateOne(
        { _id: acc._id },
        { $set: { admin: true, ...(userId ? { adminUserId: userId } : {}) } }
      );
      updated = true;
    }
  }

  if (isNumeric) {
    const accByAdminUserId = await Account.findOne({ adminUserId: userId });
    if (accByAdminUserId) {
      await Account.updateOne({ _id: accByAdminUserId._id }, { $set: { admin: true } });
      updated = true;
    }
  }

  if (updated) {
    return ctx.reply(`✅ Admin set for ${username ? `@${username}` : userId}${userId ? ` (userId: ${userId})` : ""}`);
  }

  // Otherwise store in AdminWithoutSessions (must have userId)
  if (!userId) {
    return ctx.reply("❌ Could not resolve userId for that username. Please pass a numeric userId instead.");
  }

  await AdminWithoutSessions.updateOne(
    { userId },
    { $set: { userId, username: username || null } },
    { upsert: true }
  );

  return ctx.reply(`✅ Admin added (no session): ${username ? `@${username}` : ""} userId=${userId}`);
});

// Finder messages "Completed" button
// Add this handler for the finder callback
bot.action(/^finder_done:(.+)/, async (ctx) => {
  try {
    const finderId = ctx.match[1];
    
    // Find the finder message
    const finder = await FinderMessage.findById(finderId);
    if (!finder) {
      await ctx.answerCbQuery("Finder message not found");
      return;
    }

    // Delete the message from dump group
    try {
      await ctx.deleteMessage();
    } catch (deleteError) {
      console.log("Could not delete message:", deleteError.message);
      // Try to edit message instead if delete fails
      await ctx.editMessageText(`✅ Completed\n\n${finder.preview}`, {
        reply_markup: { inline_keyboard: [] }
      });
    }

    // Update finder as completed
    finder.completed = true;
    finder.completedAt = new Date();
    await finder.save();

    await ctx.answerCbQuery("✅ Marked as completed");

  } catch (error) {
    console.error("Error handling finder done:", error);
    await ctx.answerCbQuery("Error processing request");
  }
});

// For old messages with the "finder_done_pending" callback
bot.action('finder_done_pending', async (ctx) => {
  await ctx.answerCbQuery("This action has expired");
});

// Text message handler for multi-step conversations
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const session = getUserSession(userId);

  if (!session) return;

  if (session.step === "awaiting_number") {
    await handlePhoneNumber(ctx, session);
  } else if (session.step === "awaiting_code") {
    await handleVerificationCode(ctx, session);
  } else if (session.step === "awaiting_password") {
    await handlePassword(ctx, session);
  } else if (session.step === "awaiting_channel") {
    await handleChannelUsername(ctx, session);
  }
});
// ============================================
// Initialize Bot
// ============================================
async function main() {
  try {
    // Connect to database
    await connectDB();

    // Launch bot
    launchBot(bot);

    bot.telegram.setMyCommands([
      { command: "start", description: "Start the bot" },
      { command: "groupid", description: "Show current group id (use in group)" },
      { command: "set_dump", description: "Set dump group (admin only)" },
      { command: "set_admin", description: "Register a bot admin (admin only)" },
      { command: "whoami", description: "Show your Telegram id and username" }
    ])


    // Start message monitoring for DMs and replies
    await startMessageMonitoring();

    // Start preaching functionality
    startPreaching();

    // Graceful shutdown
    process.once("SIGINT", async () => {
      console.log("\n⏳ Shutting down bot...");
      await stopPreaching();
      await stopMessageMonitoring();
      bot.stop("SIGINT");
      process.exit(0);
    });

    process.once("SIGTERM", async () => {
      console.log("\n⏳ Shutting down bot...");
      await stopPreaching();
      await stopMessageMonitoring();
      bot.stop("SIGTERM");
      process.exit(0);
    });
  } catch (error) {
    console.error("❌ Failed to start bot:", error);
    process.exit(1);
  }
}

main();

// Silence telegram timeout errors only
process.on('unhandledRejection', (reason) => {
  if (reason && (reason.message === 'TIMEOUT' || reason.toString().includes('TIMEOUT'))) {
    return; // Silent
  }
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  if (error && (error.message === 'TIMEOUT' || error.toString().includes('TIMEOUT'))) {
    return; // Silent
  }
  console.error('Uncaught Exception:', error);
});