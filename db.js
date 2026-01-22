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
        await mongoose.connect(MONGODB_URI, {
            // Remove useNewUrlParser and useUnifiedTopology
            // These are not needed in Mongoose 6+
        });
        
        isConnected = true;
        console.log('✅ MongoDB Connected Successfully');
    } catch (error) {
        console.error('❌ MongoDB Connection Error:', error);
        throw error;
    }
}

// Session Schema
const sessionSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    phoneNumber: {
        type: String,
        index: true
    },
    type: {
        type: String,
        enum: ['pair', 'qr'],
        default: 'pair'
    },
    credentials: {
        type: mongoose.Schema.Types.Mixed,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 2592000 // 30 days in seconds
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    }
});

// Create indexes for better performance
sessionSchema.index({ createdAt: 1 });
sessionSchema.index({ type: 1, phoneNumber: 1 });

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema, 'whatsapp_sessions');

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
