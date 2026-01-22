// test-mongo.js
import { connectDB, Session } from './db.js';

async function testConnection() {
    try {
        await connectDB();
        console.log('✅ MongoDB connection test passed!');
        
        // Test creating a document with valid type
        const testSessionId = 'test_' + Date.now();
        const testSession = new Session({
            sessionId: testSessionId,
            phoneNumber: '1234567890',
            type: 'test', // Now 'test' is allowed in enum
            credentials: { 
                test: true,
                data: 'Sample credentials data',
                timestamp: new Date().toISOString()
            },
            status: 'active'
        });
        
        await testSession.save();
        console.log('✅ Test document saved successfully!');
        console.log(`📋 Session ID: ${testSessionId}`);
        
        // Test reading
        const found = await Session.findOne({ sessionId: testSessionId });
        if (found) {
            console.log('✅ Test document found:', {
                sessionId: found.sessionId,
                phoneNumber: found.phoneNumber,
                type: found.type,
                status: found.status,
                createdAt: found.createdAt
            });
        } else {
            console.log('❌ Test document not found');
        }
        
        // Test updating
        await Session.updateOne(
            { sessionId: testSessionId },
            { 
                status: 'inactive',
                lastUpdated: new Date()
            }
        );
        console.log('✅ Test document updated!');
        
        // Count all test documents
        const count = await Session.countDocuments({ type: 'test' });
        console.log(`📊 Total test documents: ${count}`);
        
        // Clean up - delete test documents
        const result = await Session.deleteMany({ type: 'test' });
        console.log(`✅ ${result.deletedCount} test document(s) cleaned up`);
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Test failed:', error);
        process.exit(1);
    }
}

testConnection();
