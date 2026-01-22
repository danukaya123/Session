// verify-mongo.js
import mongoose from 'mongoose';

const MONGODB_URI = 'mongodb+srv://whatsappBotUser:IuAwNhOpza2YgrHo@mybot.7iuajoj.mongodb.net/MyBot?retryWrites=true&w=majority';

async function verifyDataLocation() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Connected to MongoDB');
        
        // Get database stats
        const db = mongoose.connection.db;
        
        // List all collections
        const collections = await db.listCollections().toArray();
        console.log('\n📁 All Collections in MyBot database:');
        collections.forEach((col, index) => {
            console.log(`${index + 1}. ${col.name}`);
        });
        
        // Check specific collections
        console.log('\n🔍 Checking specific collections:');
        
        // Check whatsapp_sessions collection
        try {
            const whatsappSessions = mongoose.connection.collection('whatsapp_sessions');
            const whatsappCount = await whatsappSessions.countDocuments();
            console.log(`📊 whatsapp_sessions count: ${whatsappCount}`);
            
            if (whatsappCount > 0) {
                const sample = await whatsappSessions.findOne({});
                console.log('✅ Sample document from whatsapp_sessions:');
                console.log(JSON.stringify(sample, null, 2));
            }
        } catch (err) {
            console.log('❌ whatsapp_sessions collection might not exist');
        }
        
        // Check sessions collection
        try {
            const sessions = mongoose.connection.collection('sessions');
            const sessionsCount = await sessions.countDocuments();
            console.log(`📊 sessions count: ${sessionsCount}`);
        } catch (err) {
            console.log('❌ sessions collection might not exist');
        }
        
        // List all databases
        console.log('\n🗄️  All databases:');
        const adminDb = db.admin();
        const dbs = await adminDb.listDatabases();
        dbs.databases.forEach(dbInfo => {
            console.log(`- ${dbInfo.name} (${dbInfo.sizeOnDisk} bytes)`);
        });
        
        await mongoose.disconnect();
        console.log('\n✅ Verification complete');
        
    } catch (error) {
        console.error('❌ Verification failed:', error);
    }
}

verifyDataLocation();
