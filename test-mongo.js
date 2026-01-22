// test-mongo.js
import { connectDB, Session } from './db.js';

async function testConnection() {
    try {
        await connectDB();
        console.log('✅ MongoDB connection test passed!');
        
        // Test creating a document
        const testSession = new Session({
            sessionId: 'test_' + Date.now(),
            phoneNumber: '1234567890',
            type: 'test',
            credentials: { test: true }
        });
        
        await testSession.save();
        console.log('✅ Test document saved successfully!');
        
        // Test reading
        const found = await Session.findOne({ sessionId: testSession.sessionId });
        console.log('✅ Test document found:', found ? 'Yes' : 'No');
        
        // Clean up
        await Session.deleteOne({ sessionId: testSession.sessionId });
        console.log('✅ Test document cleaned up');
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

testConnection();
