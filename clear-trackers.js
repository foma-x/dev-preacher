import dotenv from "dotenv";
import { connectDB, Account } from "./models/db.js";

dotenv.config();

async function clearAllDailyTrackers() {
  try {
    console.log("🔄 Connecting to MongoDB...");
    await connectDB();

    console.log("🔍 Finding all accounts...");
    const accounts = await Account.find({});

    if (accounts.length === 0) {
      console.log("ℹ️  No accounts found in database.");
      process.exit(0);
    }

    console.log(`📊 Found ${accounts.length} accounts`);

    let totalGroupsCleared = 0;
    let accountsUpdated = 0;

    for (const account of accounts) {
      let groupsUpdated = 0;
      
      if (account.groups && account.groups.length > 0) {
        // Clear dailyTracker from all groups
        for (let i = 0; i < account.groups.length; i++) {
          if (account.groups[i].dailyTracker && account.groups[i].dailyTracker.length > 0) {
            account.groups[i].dailyTracker = [];
            groupsUpdated++;
          }
        }

        if (groupsUpdated > 0) {
          // Use updateOne to avoid version conflicts
          await Account.updateOne(
            { _id: account._id },
            { $set: { groups: account.groups } }
          );
          
          accountsUpdated++;
          totalGroupsCleared += groupsUpdated;
          console.log(`  ✅ ${account.number || account.username || account._id}: Cleared ${groupsUpdated} group trackers`);
        } else {
          console.log(`  ℹ️  ${account.number || account.username || account._id}: No trackers to clear`);
        }
      } else {
        console.log(`  ℹ️  ${account.number || account.username || account._id}: No groups found`);
      }
    }

    console.log("\n✅ Done!");
    console.log(`📊 Summary:`);
    console.log(`   - Accounts updated: ${accountsUpdated}/${accounts.length}`);
    console.log(`   - Total group trackers cleared: ${totalGroupsCleared}`);

    process.exit(0);
  } catch (error) {
    console.error("❌ Error clearing daily trackers:", error);
    process.exit(1);
  }
}

clearAllDailyTrackers();

