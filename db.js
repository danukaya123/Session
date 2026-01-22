// db.js
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

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

// Session File Schema - Store each file separately
const sessionFileSchema = new mongoose.Schema({
    phoneNumber: {
        type: String,
        required: true,
        index: true
    },
    fileName: {
        type: String,
        required: true
    },
    filePath: {
        type: String, // Virtual path like "sessions/94771234567/creds.json"
        required: true
    },
    fileData: {
        type: Buffer, // Store the actual file content as Buffer
        required: true
    },
    fileType: {
        type: String,
        enum: ['creds', 'auth', 'config'],
        default: 'creds'
    },
    sessionType: {
        type: String,
        enum: ['pair', 'qr'],
        default: 'pair'
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 2592000 // Auto delete after 30 days
    }
});

// Index for faster queries
sessionFileSchema.index({ phoneNumber: 1, fileName: 1 }, { unique: true });
sessionFileSchema.index({ filePath: 1 }, { unique: true });

export const SessionFile = mongoose.model('SessionFile', sessionFileSchema, 'session_files');

// Session Metadata Schema
const sessionMetaSchema = new mongoose.Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true
    },
    phoneNumber: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['pair', 'qr'],
        default: 'pair'
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    },
    files: [{
        fileName: String,
        filePath: String,
        fileType: String
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    lastUsed: {
        type: Date,
        default: Date.now
    }
});

export const SessionMeta = mongoose.model('SessionMeta', sessionMetaSchema, 'session_metadata');

// Function to save session folder to MongoDB
export async function saveSessionFolder(phoneNumber, sessionType, localFolderPath) {
    try {
        const files = [];
        const sessionId = `${sessionType}_${phoneNumber}_${Date.now()}`;
        
        // Read all files in the session folder
        const fileNames = fs.readdirSync(localFolderPath);
        
        for (const fileName of fileNames) {
            const filePath = path.join(localFolderPath, fileName);
            const stats = fs.statSync(filePath);
            
            if (stats.isFile()) {
                // Read file content
                const fileData = fs.readFileSync(filePath);
                
                // Determine file type
                let fileType = 'other';
                if (fileName === 'creds.json') fileType = 'creds';
                else if (fileName.includes('auth')) fileType = 'auth';
                else if (fileName.includes('config')) fileType = 'config';
                
                // Create virtual path
                const virtualPath = `sessions/${phoneNumber}/${fileName}`;
                
                // Save file to MongoDB
                const sessionFile = new SessionFile({
                    phoneNumber,
                    fileName,
                    filePath: virtualPath,
                    fileData,
                    fileType,
                    sessionType
                });
                
                await sessionFile.save();
                
                files.push({
                    fileName,
                    filePath: virtualPath,
                    fileType
                });
                
                console.log(`📁 Saved file: ${fileName} for ${phoneNumber}`);
            }
        }
        
        // Save session metadata
        const sessionMeta = new SessionMeta({
            sessionId,
            phoneNumber,
            type: sessionType,
            status: 'active',
            files
        });
        
        await sessionMeta.save();
        
        console.log(`✅ Saved session folder for ${phoneNumber} with ${files.length} files`);
        console.log(`📋 Session ID: ${sessionId}`);
        
        return {
            sessionId,
            phoneNumber,
            filesCount: files.length,
            files
        };
        
    } catch (error) {
        console.error('❌ Error saving session folder:', error);
        throw error;
    }
}

// Function to get session by phone number
export async function getSessionFiles(phoneNumber) {
    return await SessionFile.find({ phoneNumber });
}

// Function to get session metadata
export async function getSessionMeta(phoneNumber) {
    return await SessionMeta.findOne({ phoneNumber, status: 'active' });
}

// Function to restore session to local folder
export async function restoreSessionFolder(phoneNumber, outputPath) {
    try {
        const files = await SessionFile.find({ phoneNumber });
        
        if (files.length === 0) {
            throw new Error(`No session files found for ${phoneNumber}`);
        }
        
        // Create output directory
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }
        
        // Restore each file
        for (const file of files) {
            const fileOutputPath = path.join(outputPath, file.fileName);
            fs.writeFileSync(fileOutputPath, file.fileData);
            console.log(`📁 Restored: ${file.fileName}`);
        }
        
        // Update last used time
        await SessionMeta.updateOne(
            { phoneNumber, status: 'active' },
            { lastUsed: new Date() }
        );
        
        console.log(`✅ Restored session for ${phoneNumber} to ${outputPath}`);
        return { success: true, filesCount: files.length };
        
    } catch (error) {
        console.error('❌ Error restoring session:', error);
        throw error;
    }
}

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

export default { 
    connectDB, 
    SessionFile,
    SessionMeta,
    saveSessionFolder,
    getSessionFiles,
    getSessionMeta,
    restoreSessionFolder
};
