// db.js
import mongoose from 'mongoose';

const MONGODB_URI = 'mongodb+srv://whatsappBotUser:AdanuwamdWhatsAppBot%5E21865@mybot.7iuajoj.mongodb.net/MyBot?retryWrites=true&w=majority';

let isConnected = false;

export async function connectDB() {
    if (isConnected) {
        console.log('✅ Using existing MongoDB connection');
        return;
    }

    try {
        await mongoose.connect(MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
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
        unique: true
    },
    phoneNumber: String,
    type: {
        type: String,
        enum: ['pair', 'qr'],
        default: 'pair'
    },
    credentials: {
        type: Object,
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: '30d' // Auto delete after 30 days
    }
});

export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema, 'whatsapp_sessions');

export default { connectDB, Session };
