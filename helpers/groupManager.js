import { Account } from '../models/db.js';
import { fetchAccountGroups, joinGroup, leaveGroup } from './telegram.js';

/**
 * Fetch and update groups for all accounts
 */
export async function fetchAllAccountGroups() {
  const accounts = await Account.find({});
  
  console.log(`📡 Fetching groups for ${accounts.length} accounts...`);
  
  for (const account of accounts) {
    console.log(`  🔍 ${account.username || account.number}...`);
    
    const groups = await fetchAccountGroups(account.session);
    
    if (groups) {
      await Account.updateOne(
        { _id: account._id },
        { $set: { groups: groups } }
      );
      console.log(`     ✅ Updated ${groups.length} groups`);
    } else {
      console.log(`     ⚠️  Failed to fetch groups`);
    }
  }
}

/**
 * Handle duplicate group memberships (remove extra members)
 */
export async function handleDuplicateGroups() {
  const accounts = await Account.find({ admin: false });
  
  // Map groupId -> [accounts]
  const groupMap = new Map();
  
  for (const account of accounts) {
    for (const group of account.groups) {
      if (!groupMap.has(group.id)) {
        groupMap.set(group.id, []);
      }
      groupMap.get(group.id).push(account);
    }
  }
  
  // Find duplicates
  const duplicates = Array.from(groupMap.entries())
    .filter(([_, accs]) => accs.length > 1);
  
  if (duplicates.length === 0) {
    console.log('  ℹ️  No duplicate memberships');
    return;
  }
  
  console.log(`  ⚠️  Found ${duplicates.length} duplicate groups`);
  
  for (const [groupId, accountsInGroup] of duplicates) {
    // Keep one random account, remove others
    const shuffled = [...accountsInGroup].sort(() => Math.random() - 0.5);
    const toLeave = shuffled.slice(0, -1);
    
    for (const account of toLeave) {
      const success = await leaveGroup(account.session, groupId);
      
      if (success) {
        await Account.updateOne(
          { _id: account._id },
          { $pull: { groups: { id: groupId } } }
        );
        console.log(`     ✅ ${account.username || account.number} left group`);
      }
    }
  }
}

/**
 * Find groups where only admin is a member
 */
export async function findAdminOnlyGroups() {
  const adminAccount = await Account.findOne({ admin: true });
  
  if (!adminAccount) {
    return [];
  }
  
  const nonAdminAccounts = await Account.find({ admin: false });
  
  // Collect all non-admin group IDs
  const nonAdminGroupIds = new Set();
  for (const account of nonAdminAccounts) {
    for (const group of account.groups) {
      nonAdminGroupIds.add(group.id);
    }
  }
  
  // Find admin-only groups
  const adminOnlyGroups = adminAccount.groups.filter(
    group => !nonAdminGroupIds.has(group.id)
  );
  
  return adminOnlyGroups;
}

/**
 * Sync newly joined groups from admin accounts into DB and ensure at least one non-admin account joins each new group.
 * Strategy:
 * - For every admin account, fetch current groups and merge into DB.
 * - For each newly discovered group (not previously in that admin's DB record), pick a random non-admin account
 *   that isn't in that group yet, try to join, and if successful add the group to that account's DB record.
 */
export async function syncAdminGroupsAndDistribute() {
  const adminAccounts = await Account.find({ admin: true });
  const nonAdminAccounts = await Account.find({ admin: false });

  if (adminAccounts.length === 0) {
    return { newGroups: 0, assigned: 0, failed: 0, details: [] };
  }

  const details = [];
  let newGroupsTotal = 0;
  let assigned = 0;
  let failed = 0;

  for (const adminAcc of adminAccounts) {
    if (!adminAcc.session) continue;

    const fetched = await fetchAccountGroups(adminAcc.session);
    if (!fetched) continue;

    const existingIds = new Set((adminAcc.groups || []).map(g => g.id));
    const newGroups = fetched.filter(g => !existingIds.has(g.id));
    newGroupsTotal += newGroups.length;

    // Update admin's group list (merge by id)
    const mergedMap = new Map();
    for (const g of (adminAcc.groups || [])) mergedMap.set(g.id, g);
    for (const g of fetched) mergedMap.set(g.id, g);
    const mergedGroups = Array.from(mergedMap.values());

    await Account.updateOne({ _id: adminAcc._id }, { $set: { groups: mergedGroups } });

    // Distribute each newly found group to one random non-admin account
    for (const group of newGroups) {
      const candidates = nonAdminAccounts.filter(a => (a.groups || []).every(g => g.id !== group.id) && a.session);
      if (candidates.length === 0) {
        failed++;
        details.push({ group: group.name, status: 'no_candidate' });
        continue;
      }

      const chosen = candidates[Math.floor(Math.random() * candidates.length)];
      const joinTarget = group.link || group.name || group.id;
      const ok = await joinGroup(chosen.session, joinTarget);

      if (!ok) {
        failed++;
        details.push({ group: group.name, status: 'join_failed', chosen: chosen.username || chosen.number });
        continue;
      }

      await Account.updateOne(
        { _id: chosen._id },
        { $push: { groups: { ...group } } }
      );

      assigned++;
      details.push({ group: group.name, status: 'assigned', chosen: chosen.username || chosen.number });
    }
  }

  return { newGroups: newGroupsTotal, assigned, failed, details };
}