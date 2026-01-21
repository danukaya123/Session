import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// Session Schema
const SessionSchema = new mongoose.Schema({
    userId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    phoneNumber: {
        type: String,
        required: true,
        index: true,
    },
    sessionType: {
        type: String,
        enum: ["pair", "qr"],
        required: true,
    },
    credentials: {
        type: mongoose.Schema.Types.Mixed,
        required: true,
    },
    deviceInfo: {
        platform: String,
        browser: String,
        userAgent: String,
    },
    status: {
        type: String,
        enum: ["active", "inactive", "expired", "blocked"],
        default: "active",
    },
    lastActive: {
        type: Date,
        default: Date.now,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    expiresAt: {
        type: Date,
        default: () => new Date(+new Date() + 90 * 24 * 60 * 60 * 1000), // 90 days
    },
});

// Auto-delete expired sessions
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Create model
export const Session =
    mongoose.models.Session || mongoose.model("Session", SessionSchema);

// UPDATED Connection function for Mongoose 7+
export async function connectDB() {
    try {
        // MongoDB Atlas connection string
        const mongoURI =
            process.env.MONGODB_URI ||
            "mongodb+srv://whatsappBotUser:AdanuwamdWhatsAppBot^21865@mybot.7iuajoj.mongodb.net/?appName=MyBot";

        console.log("🔌 Connecting to MongoDB...");

        // REMOVED deprecated options
        await mongoose.connect(mongoURI, {
            // Remove these lines:
            // useNewUrlParser: true,
            // useUnifiedTopology: true,

            // Keep only these for Mongoose 7+:
            serverSelectionTimeoutMS: 10000,
            socketTimeoutMS: 45000,
        });

        console.log("✅ MongoDB connected successfully");

        // Connection event handlers
        mongoose.connection.on("error", (err) => {
            console.error("❌ MongoDB connection error:", err);
        });

        mongoose.connection.on("disconnected", () => {
            console.log("⚠️ MongoDB disconnected");
        });

        return mongoose.connection;
    } catch (error) {
        console.error("❌ Failed to connect to MongoDB:", error.message);
        console.log("🔄 Attempting to reconnect in 5 seconds...");

        // Auto-reconnect after 5 seconds
        setTimeout(connectDB, 5000);
        throw error;
    }
}

// Helper functions
export const sessionDB = {
    // Save session
    async saveSession(data) {
        try {
            const sessionData = {
                userId: data.phoneNumber,
                phoneNumber: data.phoneNumber,
                sessionType: data.sessionType || "pair",
                credentials: data.credentials,
                deviceInfo: data.deviceInfo || {},
                status: "active",
                lastActive: new Date(),
            };

            const result = await Session.findOneAndUpdate(
                { userId: data.phoneNumber },
                sessionData,
                {
                    upsert: true,
                    new: true,
                    setDefaultsOnInsert: true,
                },
            );

            console.log(`✅ Session saved for ${data.phoneNumber}`);
            return result;
        } catch (error) {
            console.error("❌ Error saving session:", error);
            throw error;
        }
    },

    // Get session by phone number
    async getSession(phoneNumber) {
        try {
            const session = await Session.findOne({
                phoneNumber,
                status: "active",
                expiresAt: { $gt: new Date() },
            });
            return session;
        } catch (error) {
            console.error("❌ Error fetching session:", error);
            throw error;
        }
    },

    // Get all active sessions
    async getAllSessions() {
        try {
            const sessions = await Session.find({
                status: "active",
                expiresAt: { $gt: new Date() },
            });
            return sessions;
        } catch (error) {
            console.error("❌ Error fetching all sessions:", error);
            throw error;
        }
    },

    // Delete session
    async deleteSession(phoneNumber) {
        try {
            const result = await Session.deleteOne({ phoneNumber });
            console.log(`🗑️ Session deleted for ${phoneNumber}`);
            return result;
        } catch (error) {
            console.error("❌ Error deleting session:", error);
            throw error;
        }
    },

    // Update session status
    async updateStatus(phoneNumber, status) {
        try {
            const result = await Session.findOneAndUpdate(
                { phoneNumber },
                {
                    status,
                    lastActive: new Date(),
                },
                { new: true },
            );
            return result;
        } catch (error) {
            console.error("❌ Error updating session status:", error);
            throw error;
        }
    },
};
