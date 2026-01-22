// db.js
import mongoose from 'mongoose';

const MONGODB_URI = 'mongodb+srv://whatsappBotUser:IuAwNhOpza2YgrHo@mybot.7iuajoj.mongodb.net/MyBot?retryWrites=true&w=majority';

let isConnected = false;

export async function connectDB() {
    if (isConnected) {
        console.log('✅ Using existing MongoDB connection');
        return;
    }

    try {
        await mongoose.connect(MONGODB_URI);
        isConnected = true;
        console.log('✅ MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error);
        throw error;
    }
}

// Session Schema - Simplified without duplicate indexes
const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true
    },
    phoneNumber: String,
    type: {
        type: String,
        enum: ['pair', 'qr', 'test'], // Added 'test' for testing
        default: 'pair'
    },
    credentials: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        index: { expires: '30d' } // Auto delete after 30 days
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'expired'],
        default: 'active'
    }
}, {
    // Collection name
    collection: 'whatsapp_sessions'
});

// Create compound indexes for better query performance
sessionSchema.index({ phoneNumber: 1, type: 1 });
sessionSchema.index({ createdAt: 1 });
sessionSchema.index({ status: 1 });

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

// Handle connection events
mongoose.connection.on('connected', () => {
    console.log('✅ Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
    console.error('❌ Mongoose connection error:', err);
});

mongoose.connection.on('disconnected', () => {
    console.log('❌ Mongoose disconnected from MongoDB');
    isConnected = false;
});

// Graceful shutdown
process.on('SIGINT', async () => {
    await mongoose.connection.close();
    console.log('Mongoose connection closed due to app termination');
    process.exit(0);
});

export default { connectDB, Session };
