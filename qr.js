// qr.js - SIMPLIFIED WORKING VERSION
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

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
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
                printQRInTerminal: false,
                logger: pino({ level: "silent" }).child({ level: "silent" }), // Silent logger
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
                    isNewLogin
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
                    console.log("✅ Connected successfully!");
                    
                    // Wait for files to be created
                    await delay(3000);
                    
                    console.log("📱 Saving session files to MongoDB...");
                    
                    try {
                        // Save each file individually
                        const files = fs.readdirSync(dirs);
                        let savedFiles = 0;
                        
                        for (const fileName of files) {
                            const filePath = `${dirs}/${fileName}`;
                            const stats = fs.statSync(filePath);
                            
                            if (stats.isFile()) {
                                const fileData = fs.readFileSync(filePath);
                                const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || 'qr_session';
                                
                                // Determine file type
                                let fileType = 'other';
                                if (fileName === 'creds.json') fileType = 'creds';
                                else if (fileName.includes('auth')) fileType = 'auth';
                                else if (fileName.includes('config')) fileType = 'config';
                                
                                // Create unique file name with timestamp
                                const timestamp = Date.now();
                                const uniqueFileName = `${timestamp}_${fileName}`;
                                const virtualPath = `sessions/${phoneNumber}/${fileName}`;
                                
                                // Save file to database
                                const sessionFile = new SessionFile({
                                    phoneNumber,
                                    fileName: uniqueFileName,
                                    filePath: virtualPath,
                                    fileData,
                                    fileType,
                                    sessionType: 'qr'
                                });
                                
                                await sessionFile.save();
                                savedFiles++;
                                console.log(`📁 Saved: ${fileName} as ${uniqueFileName}`);
                            }
                        }
                        
                        // Save session metadata
                        const mongoSessionId = `qr_${sessionId}`;
                        const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || 'qr_session';
                        
                        const sessionMeta = new SessionMeta({
                            sessionId: mongoSessionId,
                            phoneNumber,
                            type: 'qr',
                            status: 'active'
                        });
                        
                        await sessionMeta.save();
                        
                        console.log(`✅ Saved ${savedFiles} files to MongoDB`);
                        console.log(`📋 Session ID: ${mongoSessionId}`);
                        
                        // Send confirmation message
                        try {
                            const userJid = jidNormalizedUser(KnightBot.authState.creds.me?.id || "");
                            if (userJid) {
                                await KnightBot.sendMessage(userJid, {
                                    text: `✅ WhatsApp session saved!\n\n📱 Phone: ${phoneNumber}\n🔑 Session ID: ${mongoSessionId}\n📁 Files: ${savedFiles}\n\nYour session is stored in database.`,
                                });
                                console.log("📄 Confirmation sent");
                            }
                        } catch (messageError) {
                            console.error("❌ Could not send message:", messageError.message);
                        }
                        
                    } catch (error) {
                        console.error("❌ Error saving to MongoDB:", error);
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
                }

                // Handle connection close
                if (connection === "close") {
                    isConnectionOpen = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    console.log("🔌 Connection closed with status:", statusCode);
                    
                    if (statusCode === 515) {
                        console.log("🔄 Normal disconnect after QR scan");
                        // Don't clean up immediately - session might be saved
                        setTimeout(() => {
                            removeFile(dirs);
                            console.log("🧹 Cleaned up session files");
                        }, 10000);
                    } else {
                        setTimeout(() => {
                            removeFile(dirs);
                            console.log("🧹 Cleaned up unsaved session");
                        }, 5000);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

            // Timeout for QR generation
            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ 
                        code: "QR generation timeout",
                        message: "Please try again" 
                    });
                    removeFile(dirs);
                }
            }, 60000);

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
