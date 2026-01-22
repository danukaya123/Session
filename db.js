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
        type: String,
        required: true
    },
    fileData: {
        type: Buffer,
        required: true
    },
    fileType: {
        type: String,
        enum: ['creds', 'auth', 'config', 'other'],
        default: 'creds'
    },
    sessionType: {
        type: String,
        enum: ['pair', 'qr'],
        default: 'pair'
    },
    version: {
        type: Number,
        default: 1
    },
    createdAt: {
        type: Date,
        default: Date.now,
        expires: 2592000 // Auto delete after 30 days
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Remove the unique constraint and make it compound index without unique
sessionFileSchema.index({ phoneNumber: 1, fileName: 1 });
sessionFileSchema.index({ filePath: 1 });

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
        enum: ['active', 'inactive', 'expired'],
        default: 'active'
    },
    version: {
        type: Number,
        default: 1
    },
    files: [{
        fileName: String,
        filePath: String,
        fileType: String,
        version: Number
    }],
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

sessionMetaSchema.index({ phoneNumber: 1, status: 1 });

export const SessionMeta = mongoose.model('SessionMeta', sessionMetaSchema, 'session_metadata');

// Function to save or update session folder
export async function saveSessionFolder(phoneNumber, sessionType, localFolderPath) {
    try {
        const sessionId = `${sessionType}_${phoneNumber}_${Date.now()}`;
        const files = [];
        
        // First, check if session exists for this phone number
        const existingSession = await SessionMeta.findOne({ 
            phoneNumber, 
            status: 'active',
            type: sessionType 
        });
        
        let version = 1;
        if (existingSession) {
            version = existingSession.version + 1;
            console.log(`🔄 Updating existing session v${existingSession.version} to v${version}`);
            
            // Mark old session as inactive
            existingSession.status = 'inactive';
            await existingSession.save();
        }
        
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
                
                // Create unique file path with version
                const uniqueFileName = `${version}_${fileName}`;
                const virtualPath = `sessions/${phoneNumber}/v${version}/${fileName}`;
                
                // Check if file already exists for this version
                const existingFile = await SessionFile.findOne({
                    phoneNumber,
                    fileName: uniqueFileName
                });
                
                if (existingFile) {
                    // Update existing file
                    existingFile.fileData = fileData;
                    existingFile.filePath = virtualPath;
                    existingFile.updatedAt = new Date();
                    await existingFile.save();
                    console.log(`📁 Updated file: ${fileName} (v${version})`);
                } else {
                    // Create new file with versioned name
                    const sessionFile = new SessionFile({
                        phoneNumber,
                        fileName: uniqueFileName, // Store with version prefix
                        filePath: virtualPath,
                        fileData,
                        fileType,
                        sessionType,
                        version
                    });
                    
                    await sessionFile.save();
                    console.log(`📁 Saved new file: ${fileName} (v${version})`);
                }
                
                files.push({
                    fileName,
                    filePath: virtualPath,
                    fileType,
                    version
                });
            }
        }
        
        // Save or update session metadata
        const sessionMeta = new SessionMeta({
            sessionId,
            phoneNumber,
            type: sessionType,
            status: 'active',
            version,
            files,
            updatedAt: new Date()
        });
        
        await sessionMeta.save();
        
        console.log(`✅ Saved session for ${phoneNumber} with ${files.length} files`);
        console.log(`📋 Session ID: ${sessionId}`);
        console.log(`🔢 Version: v${version}`);
        
        return {
            sessionId,
            phoneNumber,
            version,
            filesCount: files.length,
            files
        };
        
    } catch (error) {
        console.error('❌ Error saving session folder:', error);
        throw error;
    }
}

// Function to get latest active session for a phone number
export async function getLatestSession(phoneNumber, sessionType = null) {
    const query = { 
        phoneNumber, 
        status: 'active' 
    };
    
    if (sessionType) {
        query.type = sessionType;
    }
    
    return await SessionMeta.findOne(query).sort({ version: -1 });
}

// Function to get session files by version
export async function getSessionFilesByVersion(phoneNumber, version) {
    return await SessionFile.find({ 
        phoneNumber, 
        version 
    });
}

// Function to restore session to local folder
export async function restoreSessionToFolder(phoneNumber, version, outputPath) {
    try {
        const files = await SessionFile.find({ 
            phoneNumber, 
            version 
        });
        
        if (files.length === 0) {
            throw new Error(`No session files found for ${phoneNumber} v${version}`);
        }
        
        // Create output directory
        if (!fs.existsSync(outputPath)) {
            fs.mkdirSync(outputPath, { recursive: true });
        }
        
        // Restore each file (remove version prefix from filename)
        for (const file of files) {
            // Extract original filename (remove "1_" prefix)
            const originalFileName = file.fileName.replace(/^\d+_/, '');
            const fileOutputPath = path.join(outputPath, originalFileName);
            fs.writeFileSync(fileOutputPath, file.fileData);
            console.log(`📁 Restored: ${originalFileName}`);
        }
        
        // Update last used time
        await SessionMeta.updateOne(
            { phoneNumber, version, status: 'active' },
            { updatedAt: new Date() }
        );
        
        console.log(`✅ Restored session v${version} for ${phoneNumber} to ${outputPath}`);
        return { success: true, filesCount: files.length, version };
        
    } catch (error) {
        console.error('❌ Error restoring session:', error);
        throw error;
    }
}

// Function to delete old sessions
export async function cleanupOldSessions(phoneNumber, keepVersions = 3) {
    try {
        // Get all sessions ordered by version
        const allSessions = await SessionMeta.find({ phoneNumber })
            .sort({ version: -1 });
        
        if (allSessions.length > keepVersions) {
            const sessionsToDelete = allSessions.slice(keepVersions);
            
            for (const session of sessionsToDelete) {
                // Delete session files
                await SessionFile.deleteMany({ 
                    phoneNumber, 
                    version: session.version 
                });
                
                // Delete session metadata
                await SessionMeta.deleteOne({ _id: session._id });
                
                console.log(`🗑️  Deleted old session v${session.version}`);
            }
            
            return { deleted: sessionsToDelete.length };
        }
        
        return { deleted: 0 };
        
    } catch (error) {
        console.error('❌ Error cleaning up old sessions:', error);
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
    getLatestSession,
    getSessionFilesByVersion,
    restoreSessionToFolder,
    cleanupOldSessions
};
