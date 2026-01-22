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
import { connectDB, SessionFile, SessionMeta } from "./db.js";

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

    let responseSent = false; // Moved outside to prevent duplicate headers

    async function initiateSession(reconnectAttempt = 0) {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            await connectDB();
            
            const { version } = await fetchLatestBaileysVersion();

            let isConnectionOpen = false;
            let qrGenerated = false;
            let sessionSaved = false;
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
                printQRInTerminal: false,
                logger: pino({ level: "silent" }).child({ level: "silent" }),
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 15000,
                retryRequestDelayMs: 250,
                maxRetries: 3,
                emitOwnEvents: true,
                fireInitQueries: true,
            });

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, qr, isNewLogin } = update;

                console.log("🔧 Connection Update:", {
                    connection,
                    qr: qr ? "QR Available" : "No QR",
                    isNewLogin,
                    reconnectAttempt
                });

                // Generate QR code
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
                    reconnectAttempt = 0; // Reset reconnect attempts on successful connection
                    console.log("✅ Connected successfully!");
                    
                    // Wait for creds.json to be created
                    await delay(3000);
                    
                    if (!sessionSaved) {
                        console.log("📱 Saving creds.json to MongoDB...");
                        
                        try {
                            const credsPath = `${dirs}/creds.json`;
                            
                            if (fs.existsSync(credsPath)) {
                                const fileData = fs.readFileSync(credsPath);
                                let phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || 'qr_session';
                                
                                // Update phone number if available
                                if (KnightBot.authState.creds.me?.id) {
                                    phoneNumber = KnightBot.authState.creds.me.id.split(':')[0];
                                }
                                
                                // Create unique file name with timestamp
                                const timestamp = Date.now();
                                const uniqueFileName = `${timestamp}_creds.json`;
                                const virtualPath = `sessions/${phoneNumber}/creds.json`;
                                
                                // Save ONLY creds.json to database
                                const sessionFile = new SessionFile({
                                    phoneNumber,
                                    fileName: uniqueFileName,
                                    filePath: virtualPath,
                                    fileData,
                                    fileType: 'creds',
                                    sessionType: 'qr'
                                });
                                
                                await sessionFile.save();
                                console.log(`📁 Saved: creds.json as ${uniqueFileName}`);
                                
                                // Save session metadata
                                const mongoSessionId = `qr_${sessionId}_${Date.now()}`;
                                
                                const sessionMeta = new SessionMeta({
                                    sessionId: mongoSessionId,
                                    phoneNumber,
                                    type: 'qr',
                                    status: 'active'
                                });
                                
                                await sessionMeta.save();
                                
                                console.log(`✅ Saved creds.json to MongoDB`);
                                console.log(`📋 Session ID: ${mongoSessionId}`);
                                console.log(`📱 Phone: ${phoneNumber}`);
                                
                                sessionSaved = true;
                                
                                // Send confirmation message
                                try {
                                    const userJid = jidNormalizedUser(KnightBot.authState.creds.me?.id || "");
                                    if (userJid) {
                                        await KnightBot.sendMessage(userJid, {
                                            text: `✅ WhatsApp session saved successfully!\n\n📱 Phone: ${phoneNumber}\n🔑 Session ID: ${mongoSessionId}\n\nYour session is now stored securely in the database.`,
                                        });
                                        console.log("📄 Confirmation message sent");
                                    }
                                } catch (messageError) {
                                    console.error("❌ Could not send message:", messageError.message);
                                }
                                
                                // Keep connection alive
                                const keepAlive = setInterval(() => {
                                    if (isConnectionOpen) {
                                        KnightBot.sendPresenceUpdate('available').catch(() => {
                                            // Ignore errors
                                        });
                                    } else {
                                        clearInterval(keepAlive);
                                    }
                                }, 25000);
                                
                                // Clean up local files after 10 seconds
                                setTimeout(() => {
                                    if (sessionSaved) {
                                        removeFile(dirs);
                                        console.log("🧹 Cleaned up local session files");
                                    }
                                }, 10000);
                                
                            } else {
                                console.log("❌ creds.json not found in session folder");
                            }
                            
                        } catch (error) {
                            console.error("❌ Error saving to MongoDB:", error);
                        }
                    }
                }

                // Handle connection close
                if (connection === "close") {
                    isConnectionOpen = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    console.log("🔌 Connection closed with status:", statusCode);
                    
                    if (statusCode === 515) {
                        console.log("🔄 Normal disconnect after QR scan. Attempting reconnection...");
                        
                        // Try to reconnect if we haven't saved the session yet
                        if (!sessionSaved && reconnectAttempt < maxReconnectAttempts) {
                            reconnectAttempt++;
                            console.log(`🔄 Reconnection attempt ${reconnectAttempt}/${maxReconnectAttempts}`);
                            
                            setTimeout(async () => {
                                try {
                                    console.log("🔄 Attempting to reconnect...");
                                    await initiateSession(reconnectAttempt);
                                } catch (reconnectError) {
                                    console.error("❌ Reconnection failed:", reconnectError.message);
                                    
                                    // Try to save creds.json anyway if it exists
                                    const credsPath = `${dirs}/creds.json`;
                                    if (fs.existsSync(credsPath)) {
                                        try {
                                            console.log("🔄 Trying to save creds.json after failed reconnection...");
                                            const fileData = fs.readFileSync(credsPath);
                                            let phoneNumber = 'qr_session';
                                            
                                            // Try to read phone number from creds.json
                                            try {
                                                const credsData = JSON.parse(fileData.toString());
                                                phoneNumber = credsData.me?.id?.split(':')[0] || phoneNumber;
                                            } catch (e) {
                                                console.error("❌ Could not parse creds.json:", e.message);
                                            }
                                            
                                            const timestamp = Date.now();
                                            const uniqueFileName = `${timestamp}_creds_emergency.json`;
                                            
                                            const sessionFile = new SessionFile({
                                                phoneNumber,
                                                fileName: uniqueFileName,
                                                filePath: `sessions/${phoneNumber}/emergency/creds.json`,
                                                fileData,
                                                fileType: 'creds',
                                                sessionType: 'qr'
                                            });
                                            
                                            await sessionFile.save();
                                            console.log("✅ Emergency backup of creds.json saved");
                                            
                                        } catch (emergencyError) {
                                            console.error("❌ Emergency backup failed:", emergencyError.message);
                                        }
                                    }
                                    
                                    // Clean up after all attempts
                                    setTimeout(() => {
                                        removeFile(dirs);
                                        console.log("🧹 Cleaned up session files after failed reconnections");
                                    }, 5000);
                                }
                            }, 2000); // Wait 2 seconds before reconnecting
                        } else if (sessionSaved) {
                            console.log("✅ Session already saved. Connection can close.");
                            setTimeout(() => {
                                removeFile(dirs);
                                console.log("🧹 Cleaned up local files");
                            }, 5000);
                        } else {
                            console.log("❌ Max reconnection attempts reached");
                            setTimeout(() => {
                                removeFile(dirs);
                                console.log("🧹 Cleaned up unsaved session files");
                            }, 5000);
                        }
                    } else {
                        console.log("⚠️ Unexpected disconnect");
                        setTimeout(() => {
                            removeFile(dirs);
                            console.log("🧹 Cleaned up session files");
                        }, 5000);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

        } catch (err) {
            console.error("❌ Error initializing session:", err);
            if (!responseSent) {
                responseSent = true;
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
