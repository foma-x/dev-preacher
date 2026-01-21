# Bot Commands

This document lists all commands available in **dev-preacher**, what they do, and who can use them.

## Roles / Access

- **Anyone**: Any Telegram user can run the command.
- **Admin**: Only users recognized as admins by the bot can run the command.
  - Admins are determined by:
    - `Account` documents with `admin: true` and a valid `adminUserId`
    - `adminWithoutSessions` collection (`AdminWithoutSessions`) entries

## Commands

### `/start`
- **Access**: Anyone
- **What it does**: Opens the bot menu and entry points (add account, refresh groups, etc.).

### `/groupId`
- **Access**: Anyone (but only works inside groups/supergroups/channels)
- **What it does**: Replies with the current chat ID. Use this to get the `groupId` value needed by `/set_dump`.
- **Notes**: If used in a private chat, the bot replies with “Use this command inside a group.”

### `/set_dump {groupId}`
- **Access**: Admin
- **What it does**: Saves the dump group ID in DB (`System.dumpGroupId`).
- **Why**: Enables the “finder” feature (keyword detection) to forward matching messages into the dump group.
- **Notes**:
  - If no dump group is set, finder forwarding is disabled (messages are ignored).
  - Only works when the sender is recognized as admin via:
    - `Account` with `admin:true` and `adminUserId === ctx.from.id`
    - or `AdminWithoutSessions` with `userId === ctx.from.id`

### `/set_admin {username | userId}`
- **Access**: Admin
- **What it does**:
  - If `{username}` matches an existing `Account.username`, sets that account’s `admin` to `true` (and stores `adminUserId` if resolvable).
  - Otherwise, stores the admin in `adminWithoutSessions` (requires a resolvable/provided `userId`).
- **Why**: Removes hardcoded admin credentials and allows multiple admins.

### `/whoami`
- **Access**: Anyone
- **What it does**: Shows your Telegram numeric `id` and your `username` (if set).
- **Why**: Helps you know what to pass into `/set_admin` or to debug admin detection.

## Menu Actions (Buttons)

These are not typed commands; they are accessed via the bot UI menu.

### **Refresh Groups**
- **Access**: Anyone with access to the bot UI (recommended: Admins only operationally)
- **What it does**:
  - Syncs admin account’s newly joined groups into DB.
  - For each newly discovered admin group, picks a random non-admin account and attempts to join it automatically.
  - Refreshes group lists for all accounts and optionally removes duplicate non-admin memberships.
- **Notes**: Join may fail depending on group privacy/invite type; failures are reported in the refresh summary.

### **Start Preaching / Stop Preaching**
- **Access**: Anyone with access to the bot UI menu
- **What it does**:
  - Starts/stops the scheduled message sending system (“preaching”) across non-admin accounts.
  - Message timing is based on `msgPerDay` and the activity guard (don’t send if your message is in last 8).

### **Restart Monitoring**
- **Access**: Anyone with access to the bot UI menu
- **What it does**: Restarts message monitoring clients.

## “Finder” Completed Button

### **Completed** (inline button in dump group)
- **Access**: Admin
- **What it does**:
  - Deletes the forwarded dump message.
  - Deletes the associated DB record from `finderMessages`.


