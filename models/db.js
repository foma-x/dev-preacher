import mongoose from "mongoose";

// Account Schema
const accountSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    username: String,
    admin: { type: Boolean, default: false },
    // If this account is also an admin of the bot, store the bot userId so we can notify them.
    adminUserId: { type: String, default: null },
    session: String,
    currentMessageId: { type: Number, default: 0 }, // Account-level message ID
    groups: [
      {
        dailyTracker: [{ date: String, messageCount: Number, lastSentAt:String }],
        name: String,
        link: String,
        msgPerDay: { type: Number, default: 5 },
        id: String,
        lastMessageId: { type: Number, default: 0 }, // Keep for backward compatibility
      },
    ],
  },
  { timestamps: true }
);

export const Account = mongoose.model("Account", accountSchema);

// Customer Schema - For storing DM/reply interactions
const customerSchema = new mongoose.Schema(
  {
    username: String,
    userId: String,
    textedAt: { type: Date, default: Date.now },
    type: { type: String, enum: ['dm', 'reply', 'finding-a-dev'], required: true },
    content: String,
    senderAccount: String, // Account that received the DM/reply
    groupId: String, // For replies, the group where the reply was made
  },
  { timestamps: true }
);

export const Customer = mongoose.model("Customer", customerSchema);

// System Schema - For bot settings
const systemSchema = new mongoose.Schema(
  {
    reportChannel: { type: String, default: null },
    dumpGroupId: { type: String, default: null },
  },
  { timestamps: true }
);

export const System = mongoose.model("System", systemSchema);

// Admins without sessions (bot admins who don't have a GramJS session stored)
const adminWithoutSessionsSchema = new mongoose.Schema(
  {
    username: { type: String, default: null },
    userId: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

export const AdminWithoutSessions = mongoose.model("AdminWithoutSessions", adminWithoutSessionsSchema);

// Finder messages stored for dump group moderation
const finderMessageSchema = new mongoose.Schema(
  {
    dumpGroupId: { type: String, required: true },
    dumpMessageId: { type: Number, required: true },
    sourceChatId: { type: String, required: true },
    sourceMessageId: { type: Number, required: true },
    sourceLink: { type: String, required: true },
    senderUserId: { type: String, required: true },
    preview: { type: String, required: true },
  },
  { timestamps: true }
);

export const FinderMessage = mongoose.model("FinderMessage", finderMessageSchema);

// Connect to MongoDB
export async function connectDB() {
  try {
    // Enforce schema validation on update operations (updateOne/findOneAndUpdate/etc.)
    // Creates/saves are validated by default; updates are NOT unless runValidators is enabled.
    mongoose.set('runValidators', true);

    await mongoose.connect(process.env.MONGODB_URI, {
      dbName: "dev-preacher",
    });

    console.log("✅ Connected to MongoDB");
    
    
  } catch (error) {
    console.error("❌ MongoDB connection error:", error);
    throw error;
  }
}
