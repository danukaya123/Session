// quick-test.js
import { connectDB, Session } from './db.js';

async function quickTest() {
    await connectDB();
    
    const testId = `quick_test_${Date.now()}`;
    console.log(`🚀 Creating test document with ID: ${testId}`);
    
    const testDoc = new Session({
        sessionId: testId,
        phoneNumber: '94771234567',
        type: 'pair',
        credentials: {
            test: 'immediate_test',
            timestamp: new Date().toISOString(),
            sampleData: 'This should appear in MongoDB Atlas'
        },
        status: 'active'
    });
    
    await testDoc.save();
    console.log('✅ Document saved!');
    
    // Give it a moment
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verify
    const found = await Session.findOne({ sessionId: testId });
    console.log('🔍 Verification:', found ? 'FOUND ✓' : 'NOT FOUND ✗');
    
    if (found) {
        console.log('\n📋 Document details:');
        console.log(`   ID: ${found.sessionId}`);
        console.log(`   Phone: ${found.phoneNumber}`);
        console.log(`   Type: ${found.type}`);
        console.log(`   Created: ${found.createdAt}`);
        console.log(`   Collection: ${found.collection.name}`);
    }
    
    console.log('\n📌 Now check MongoDB Atlas:');
    console.log('   1. Go to MongoDB Atlas');
    console.log('   2. Click "Browse Collections"');
    console.log('   3. Database: MyBot');
    console.log('   4. Collection: whatsapp_sessions');
    console.log('   5. Look for document with ID:', testId);
    
    process.exit(0);
}

quickTest().catch(console.error);
