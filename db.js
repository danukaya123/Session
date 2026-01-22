// db.js - SIMPLE VERSION
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

// Simple Session File Schema
const sessionFileSchema = new mongoose.Schema({
    phoneNumber: String,
    fileName: String,
    filePath: String,
    fileData: Buffer,
    fileType: String,
    sessionType: String,
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export const SessionFile = mongoose.model('SessionFile', sessionFileSchema, 'session_files');

// Simple Session Metadata
const sessionMetaSchema = new mongoose.Schema({
    sessionId: String,
    phoneNumber: String,
    type: String,
    status: {
        type: String,
        default: 'active'
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

export const SessionMeta = mongoose.model('SessionMeta', sessionMetaSchema, 'session_metadata');

mongoose.connection.on('connected', () => {
    console.log('✅ Mongoose connected to MongoDB');
});

mongoose.connection.on('error', (err) => {
    console.error('❌ Mongoose connection error:', err);
});

export default { 
    connectDB, 
    SessionFile,
    SessionMeta
};
