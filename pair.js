import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pn from "awesome-phonenumber";
import { sessionDB } from "./database.js";

const router = express.Router();

// Store active sessions to prevent immediate closure
const activeSessions = new Map();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

router.get("/", async (req, res) => {
    try {
        let num = req.query.number;
        
        if (!num) {
            return res.status(400).send({
                success: false,
                message: "Phone number is required"
            });
        }
        
        // Clean the number
        num = num.replace(/[^0-9]/g, "");
        
        // Validate phone number
        const phone = pn("+" + num);
        if (!phone.isValid()) {
            return res.status(400).send({
                success: false,
                message: "Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces."
            });
        }
        
        num = phone.getNumber("e164").replace("+", "");
        console.log(`📱 Processing pair request for: ${num}`);
        
        // Check if session already exists
        const existingSession = await sessionDB.getSession(num);
        if (existingSession) {
            return res.status(409).send({
                success: false,
                message: "Session already exists for this number. Please delete it first or use a different number."
            });
        }
        
        const dirs = `./sessions/pair_${num}_${Date.now()}`;
        
        // Remove any existing directory
        await removeFile(dirs);
        
        // Create directory
        if (!fs.existsSync(dirs)) {
            fs.mkdirSync(dirs, { recursive: true });
        }
        
        let responseSent = false;
        let knightBot = null;
        
        async function initiateSession() {
            const { state, saveCreds } = await useMultiFileAuthState(dirs);
            
            try {
                const { version } = await fetchLatestBaileysVersion();
                
                knightBot = makeWASocket({
                    version,
                    auth: {
                        creds: state.creds,
                        keys: makeCacheableSignalKeyStore(
                            state.keys,
                            pino({ level: "fatal" }).child({ level: "fatal" }),
                        ),
                    },
                    printQRInTerminal: false,
                    logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                    browser: Browsers.windows("Chrome"),
                    markOnlineOnConnect: false,
                    generateHighQualityLinkPreview: false,
                    defaultQueryTimeoutMs: 60000,
                    connectTimeoutMs: 60000,
                    keepAliveIntervalMs: 30000,
                    retryRequestDelayMs: 250,
                    maxRetries: 5,
                });
                
                // Store in active sessions
                activeSessions.set(num, { knightBot, dirs });
                
                knightBot.ev.on("connection.update", async (update) => {
                    const { connection, lastDisconnect, isNewLogin, isOnline } = update;
                    
                    console.log(`🔗 ${num}: Connection update:`, connection);
                    
                    if (connection === "open") {
                        console.log(`✅ ${num}: Connected successfully via pair code!`);
                        
                        try {
                            // Read credentials from file
                            const credsPath = dirs + "/creds.json";
                            if (fs.existsSync(credsPath)) {
                                const credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                                
                                // Save to MongoDB
                                await sessionDB.saveSession({
                                    phoneNumber: num,
                                    sessionType: 'pair',
                                    credentials: credentials,
                                    deviceInfo: {
                                        platform: 'web',
                                        browser: 'Chrome',
                                        userAgent: req.headers['user-agent'] || 'Unknown'
                                    }
                                });
                                
                                console.log(`💾 ${num}: Session saved to MongoDB`);
                                
                                // Send success message to user
                                const userJid = jidNormalizedUser(num + "@s.whatsapp.net");
                                
                                await knightBot.sendMessage(userJid, {
                                    text: `✅ *SESSION SAVED SUCCESSFULLY!*\n\n📱 Your WhatsApp bot is now connected!\n\n🔑 Session ID: ${num}\n⏰ Expires: 90 days\n\n📊 *Bot Features:*\n• Auto-reply messages\n• Group management\n• Media downloader\n• And much more!\n\nType *.menu* to see all commands.`
                                });
                                
                                console.log(`📩 ${num}: Welcome message sent`);
                            }
                        } catch (saveError) {
                            console.error(`❌ ${num}: Error saving session:`, saveError);
                        }
                        
                        // Clean up local files after 10 seconds
                        setTimeout(() => {
                            removeFile(dirs);
                            activeSessions.delete(num);
                        }, 10000);
                    }
                    
                    if (isNewLogin) {
                        console.log(`🔐 ${num}: New login via pair code`);
                    }
                    
                    if (isOnline) {
                        console.log(`📶 ${num}: Client is online`);
                    }
                    
                    if (connection === "close") {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;
                        
                        console.log(`🔌 ${num}: Connection closed (Status: ${statusCode})`);
                        
                        // Don't update status if it's just normal closure after pairing
                        if (statusCode !== 401) {
                            await sessionDB.updateStatus(num, 'inactive');
                        }
                        
                        // Clean up
                        removeFile(dirs);
                        activeSessions.delete(num);
                    }
                });
                
                // Request pairing code if not registered
                if (!knightBot.authState.creds.registered) {
                    await delay(3000);
                    
                    try {
                        let code = await knightBot.requestPairingCode(num);
                        code = code?.match(/.{1,4}/g)?.join("-") || code;
                        
                        if (!responseSent) {
                            responseSent = true;
                            
                            res.send({
                                success: true,
                                phoneNumber: num,
                                pairingCode: code,
                                message: "Use this pairing code in your WhatsApp app",
                                instructions: [
                                    "1. Open WhatsApp on your phone",
                                    "2. Go to Settings → Linked Devices",
                                    '3. Tap "Link a Device"',
                                    "4. Enter this code: " + code,
                                    "5. Wait for connection confirmation (this may take 30-60 seconds)",
                                    "6. You'll receive a confirmation message once connected"
                                ],
                                note: "Keep this page open while connecting. Do not refresh!"
                            });
                            
                            console.log(`📟 ${num}: Pairing code generated: ${code}`);
                            
                            // Keep connection alive for 5 minutes to allow WhatsApp to connect
                            setTimeout(() => {
                                if (knightBot && knightBot.user) {
                                    console.log(`⏰ ${num}: Keeping connection alive for pairing...`);
                                }
                            }, 30000);
                        }
                    } catch (error) {
                        console.error(`❌ ${num}: Error requesting pairing code:`, error);
                        
                        if (!responseSent) {
                            responseSent = true;
                            res.status(503).send({
                                success: false,
                                message: "Failed to get pairing code. Please check your phone number and try again."
                            });
                        }
                        
                        removeFile(dirs);
                        activeSessions.delete(num);
                    }
                }
                
                knightBot.ev.on("creds.update", saveCreds);
                
            } catch (err) {
                console.error(`❌ ${num}: Error initializing session:`, err);
                
                if (!responseSent) {
                    responseSent = true;
                    res.status(500).send({
                        success: false,
                        message: "Service Unavailable. Please try again later."
                    });
                }
                
                removeFile(dirs);
                activeSessions.delete(num);
            }
        }
        
        // Start session initiation
        await initiateSession();
        
    } catch (error) {
        console.error("❌ Pair route error:", error);
        
        if (!res.headersSent) {
            res.status(500).send({
                success: false,
                message: "Internal server error"
            });
        }
    }
});

// Keep the process alive
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (
        e.includes("Stream Errored") ||
        e.includes("Stream Errored (restart required)")
    )
        return;
    if (e.includes("statusCode: 515") || e.includes("statusCode: 503")) return;
    console.log("Caught exception: ", err);
});

export default router;
