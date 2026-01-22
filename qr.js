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
import { connectDB, Session } from "./db.js";

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
    const dirs = `./qr_sessions/session_${sessionId}`;

    if (!fs.existsSync("./qr_sessions")) {
        fs.mkdirSync("./qr_sessions", { recursive: true });
    }

    await removeFile(dirs);

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            // Connect to MongoDB
            await connectDB();
            
            const { version } = await fetchLatestBaileysVersion();

            let responseSent = false;
            let isConnectionOpen = false;
            let qrGenerated = false;

            const KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" }),
                    ),
                },
                printQRInTerminal: true, // Enable for debugging
                logger: pino({ level: "info" }).child({ level: "info" }), // Increase log level
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: true, // Set to true to stay online
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000, // Send keep-alive every 10 seconds
                retryRequestDelayMs: 250,
                maxRetries: 5,
                emitOwnEvents: true,
                fireInitQueries: true,
            });

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;

                console.log("🔧 Connection Update:", {
                    connection,
                    qr: qr ? "QR Available" : "No QR",
                    isNewLogin
                });

                // Handle QR Code generation
                if (qr && !responseSent && !qrGenerated) {
                    qrGenerated = true;
                    console.log("🟢 QR Code Generated! Scan it with your WhatsApp app.");

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

                // Handle connection open
                if (connection === "open") {
                    isConnectionOpen = true;
                    console.log("✅ Connected successfully!");
                    
                    // Wait a bit for credentials to be saved
                    await delay(2000);
                    
                    console.log("📱 Saving session to MongoDB...");
                    
                    try {
                        const credsPath = dirs + "/creds.json";
                        let retries = 5;
                        
                        while (retries > 0 && !fs.existsSync(credsPath)) {
                            console.log(`⏳ Waiting for creds.json... (${retries} retries left)`);
                            await delay(1000);
                            retries--;
                        }
                        
                        if (fs.existsSync(credsPath)) {
                            const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || 'qr_session';
                            
                            // Save to MongoDB
                            const mongoSessionId = `qr_${sessionId}`;
                            const sessionDoc = new Session({
                                sessionId: mongoSessionId,
                                phoneNumber: phoneNumber,
                                type: 'qr',
                                credentials: credsData,
                                status: 'active'
                            });
                            
                            await sessionDoc.save();
                            console.log("✅ Session saved to MongoDB. Session ID:", mongoSessionId);

                            // Send session ID to user
                            const userJid = jidNormalizedUser(KnightBot.authState.creds.me?.id || "");
                            if (userJid) {
                                try {
                                    await KnightBot.sendMessage(userJid, {
                                        text: `Session ID: ${mongoSessionId}\nYour WhatsApp session has been linked successfully!`,
                                    });
                                    console.log("📄 Session ID sent successfully");
                                } catch (sendError) {
                                    console.error("❌ Error sending message:", sendError);
                                }
                            }
                            
                            // Keep connection alive by sending periodic pings
                            setInterval(async () => {
                                if (isConnectionOpen) {
                                    try {
                                        await KnightBot.sendPresenceUpdate('available');
                                        console.log("💓 Keep-alive ping sent");
                                    } catch (pingError) {
                                        console.error("Keep-alive error:", pingError);
                                    }
                                }
                            }, 30000); // Every 30 seconds
                            
                        } else {
                            console.log("❌ Creds file not found after waiting");
                        }
                    } catch (error) {
                        console.error("❌ Error saving to MongoDB:", error);
                    }
                    
                    // Don't remove files yet - keep them for reconnection
                    console.log("📁 Session files kept for reconnection");
                }

                // Handle connection close
                if (connection === "close") {
                    isConnectionOpen = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const error = lastDisconnect?.error;
                    
                    console.log("🔌 Connection closed:", {
                        statusCode,
                        error: error?.message || error
                    });

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp. Need to generate new QR code.");
                        // Clean up files since session is invalid
                        removeFile(dirs);
                    } else if (statusCode === 403) {
                        console.log("❌ Session blocked. Need new QR code.");
                        removeFile(dirs);
                    } else if (statusCode === 419) {
                        console.log("❌ Session expired. Need new QR code.");
                        removeFile(dirs);
                    } else {
                        console.log("⚠️ Connection lost. Will try to reconnect...");
                        // Don't remove files - allow reconnection
                        setTimeout(() => {
                            if (!isConnectionOpen) {
                                console.log("🔄 Attempting to reconnect...");
                                // Reuse the same session files
                                initiateSession();
                            }
                        }, 5000);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
                }
            });

            // Handle credentials updates
            KnightBot.ev.on("creds.update", async (creds) => {
                saveCreds(creds);
                
                if (isConnectionOpen) {
                    try {
                        const credsPath = dirs + "/creds.json";
                        if (fs.existsSync(credsPath)) {
                            const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || 'qr_session';
                            
                            await Session.findOneAndUpdate(
                                { sessionId: `qr_${sessionId}` },
                                { 
                                    credentials: credsData, 
                                    phoneNumber: phoneNumber,
                                    lastUpdated: new Date(),
                                    status: 'active'
                                },
                                { upsert: true, new: true }
                            );
                            console.log("🔄 Session credentials updated in MongoDB");
                        }
                    } catch (error) {
                        console.error("Error updating session in MongoDB:", error);
                    }
                }
            });

            // Handle messages (to keep connection alive)
            KnightBot.ev.on("messages.upsert", (m) => {
                console.log("📨 Received message update");
            });

            // Set timeout for QR generation
            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ 
                        code: "QR generation timeout",
                        message: "Please try again" 
                    });
                    removeFile(dirs);
                }
            }, 45000); // 45 seconds timeout

        } catch (err) {
            console.error("❌ Error initializing session:", err);
            if (!responseSent) {
                res.status(503).send({ 
                    code: "Service Unavailable",
                    message: "Failed to initialize session" 
                });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;
