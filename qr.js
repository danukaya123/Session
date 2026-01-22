// qr.js
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
import QRCode from "qrcode";
import { connectDB, saveSessionFolder } from "./db.js";

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

router.get("/", async (req, res) => {
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const sessionFolder = `./temp_sessions/qr_${sessionId}`;

    if (!fs.existsSync("./temp_sessions")) {
        fs.mkdirSync("./temp_sessions", { recursive: true });
    }

    await removeFile(sessionFolder);

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

        try {
            await connectDB();
            
            const { version } = await fetchLatestBaileysVersion();

            let responseSent = false;
            let isConnectionOpen = false;
            let sessionSaved = false;
            let qrGenerated = false;
            let reconnectAttempts = 0;
            const maxReconnectAttempts = 3;

            const KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" }),
                    ),
                },
                // Remove printQRInTerminal since it's deprecated
                logger: pino({ level: "error" }).child({ level: "error" }), // Only log errors
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: false, // Changed to false
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 20000,
                retryRequestDelayMs: 500,
                maxRetries: 3,
                emitOwnEvents: true,
                fireInitQueries: true,
                shouldIgnoreJid: (jid) => jid?.endsWith('@g.us') || jid?.endsWith('@broadcast'),
            });

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin, qr } = update;

                console.log("🔧 Connection Update:", { 
                    connection, 
                    qr: qr ? "QR Available" : "No QR",
                    isNewLogin 
                });

                // Generate QR code
                if (qr && !responseSent && !qrGenerated) {
                    qrGenerated = true;
                    console.log("🟢 QR Code Generated!");

                    try {
                        const qrDataURL = await QRCode.toDataURL(qr, {
                            errorCorrectionLevel: "M",
                            type: "image/png",
                            quality: 0.92,
                            margin: 1,
                            color: {
                                dark: "#000000",
                                light: "#FFFFFF",
                            },
                        });

                        if (!responseSent) {
                            responseSent = true;
                            console.log("QR Code sent to client");
                            res.send({
                                qr: qrDataURL,
                                message: "QR Code Generated! Scan it with your WhatsApp app.",
                                instructions: [
                                    "1. Open WhatsApp on your phone",
                                    "2. Go to Settings > Linked Devices",
                                    '3. Tap "Link a Device"',
                                    "4. Scan the QR code above",
                                ],
                            });
                        }
                    } catch (qrError) {
                        console.error("Error generating QR code:", qrError);
                        if (!responseSent) {
                            responseSent = true;
                            res.status(500).send({
                                code: "Failed to generate QR code",
                            });
                        }
                    }
                }

                if (connection === "open") {
                    isConnectionOpen = true;
                    reconnectAttempts = 0;
                    console.log("✅ Connected successfully!");
                    
                    // IMPORTANT: Wait longer for WhatsApp to stabilize
                    await delay(5000);
                    
                    if (!sessionSaved) {
                        console.log("📱 Checking for session files...");
                        
                        try {
                            // Wait for creds.json to be created
                            let retries = 10;
                            while (retries > 0) {
                                const credsPath = `${sessionFolder}/creds.json`;
                                if (fs.existsSync(credsPath)) {
                                    const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                                    console.log("📄 creds.json found and valid!");
                                    
                                    const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || `qr_${sessionId}`;
                                    
                                    console.log("📱 Saving session folder to MongoDB...");
                                    const result = await saveSessionFolder(phoneNumber, 'qr', sessionFolder);
                                    
                                    console.log("✅ Session folder saved to MongoDB!");
                                    console.log(`📋 Session ID: ${result.sessionId}`);
                                    console.log(`📁 Files saved: ${result.filesCount}`);
                                    
                                    // Send success message
                                    const userJid = jidNormalizedUser(KnightBot.authState.creds.me?.id || "");
                                    if (userJid) {
                                        try {
                                            await KnightBot.sendMessage(userJid, {
                                                text: `✅ WhatsApp QR session saved successfully!\n\n📱 Phone: ${phoneNumber}\n🔑 Session ID: ${result.sessionId}\n📁 Files: ${result.filesCount}\n\nYour session is now stored securely in the database.`,
                                            });
                                            console.log("📄 Success message sent");
                                        } catch (sendError) {
                                            console.error("❌ Error sending message:", sendError);
                                        }
                                    }
                                    
                                    sessionSaved = true;
                                    
                                    // Clean up local files after a delay
                                    setTimeout(() => {
                                        removeFile(sessionFolder);
                                        console.log("🧹 Cleaned up local temp files");
                                    }, 10000); // Give more time
                                    
                                    break;
                                }
                                console.log(`⏳ Waiting for creds.json... (${retries} retries left)`);
                                await delay(1000);
                                retries--;
                            }
                            
                            if (!sessionSaved) {
                                console.log("❌ creds.json not found after waiting");
                            }
                            
                        } catch (error) {
                            console.error("❌ Error saving QR session:", error);
                        }
                    }
                    
                    // Don't keep connection alive aggressively - WhatsApp might disconnect
                    const keepAliveInterval = setInterval(async () => {
                        if (isConnectionOpen) {
                            try {
                                await KnightBot.sendPresenceUpdate('unavailable'); // Use unavailable instead of available
                                console.log("💤 Presence updated (unavailable)");
                            } catch (pingError) {
                                console.error("Presence update error:", pingError);
                                clearInterval(keepAliveInterval);
                            }
                        } else {
                            clearInterval(keepAliveInterval);
                        }
                    }, 60000); // Every 60 seconds
                }

                if (connection === "close") {
                    isConnectionOpen = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const error = lastDisconnect?.error;
                    
                    console.log("🔌 Connection closed:", {
                        statusCode,
                        error: error?.message || "Unknown error"
                    });
                    
                    // Error 515 is normal after QR scan - it means restart is required
                    if (statusCode === 515 || statusCode === 401) {
                        console.log("🔄 This is expected after QR scan. Session should be saved.");
                        
                        if (!sessionSaved) {
                            // Try to save session anyway
                            try {
                                await delay(2000);
                                const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || `qr_${sessionId}`;
                                
                                if (fs.existsSync(sessionFolder)) {
                                    console.log("🔄 Attempting to save session after disconnect...");
                                    const result = await saveSessionFolder(phoneNumber, 'qr', sessionFolder);
                                    console.log("✅ Session saved after disconnect!");
                                    sessionSaved = true;
                                }
                            } catch (saveError) {
                                console.error("❌ Failed to save after disconnect:", saveError);
                            }
                        }
                    }
                    
                    // Clean up if session wasn't saved
                    if (!sessionSaved) {
                        setTimeout(() => {
                            removeFile(sessionFolder);
                            console.log("🧹 Cleaned up unsaved QR session files");
                        }, 3000);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

            // Handle connection errors
            KnightBot.ev.on("connection.phone.code", (code) => {
                console.log("📱 Phone code received:", code);
            });

            // Set timeout for QR generation
            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ 
                        code: "QR generation timeout",
                        message: "Please try again" 
                    });
                    removeFile(sessionFolder);
                }
            }, 60000); // 60 seconds timeout

        } catch (err) {
            console.error("❌ Error initializing session:", err);
            if (!responseSent) {
                res.status(503).send({ 
                    code: "Service Unavailable",
                    message: "Failed to initialize session" 
                });
            }
            removeFile(sessionFolder);
        }
    }

    await initiateSession();
});

export default router;
