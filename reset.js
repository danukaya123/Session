// reset-db.js
import { connectDB } from './db.js';
import mongoose from 'mongoose';

async function resetDB() {
    try {
        await connectDB();
        
        console.log('🧹 Resetting database...');
        
        // Drop collections
        await mongoose.connection.db.dropCollection('session_files');
        console.log('🗑️  Dropped session_files');
        
        await mongoose.connection.db.dropCollection('session_metadata');
        console.log('🗑️  Dropped session_metadata');
        
        console.log('✅ Database reset complete!');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Reset failed:', error);
        process.exit(1);
    }
}

resetDB();
