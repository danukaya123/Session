// debug-session.js
import fs from 'fs';
import path from 'path';

async function debugSession() {
    const sessionFolder = './temp_sessions/94716252841'; // Change to your actual folder
    if (fs.existsSync(sessionFolder)) {
        console.log(`📁 Session folder exists: ${sessionFolder}`);
        const files = fs.readdirSync(sessionFolder);
        console.log(`📋 Files found: ${files.length}`);
        
        files.forEach(file => {
            const filePath = path.join(sessionFolder, file);
            const stats = fs.statSync(filePath);
            console.log(`  ${file} - ${stats.size} bytes`);
            
            if (file === 'creds.json') {
                try {
                    const content = fs.readFileSync(filePath, 'utf8');
                    const parsed = JSON.parse(content);
                    console.log(`  ✅ creds.json is valid JSON`);
                    console.log(`  📱 Phone: ${parsed.me?.id || 'Not found'}`);
                } catch (e) {
                    console.log(`  ❌ creds.json is invalid: ${e.message}`);
                }
            }
        });
    } else {
        console.log(`❌ Session folder doesn't exist: ${sessionFolder}`);
    }
}

debugSession();
