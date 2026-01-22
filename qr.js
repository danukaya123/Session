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

            const KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" }),
                    ),
                },
                printQRInTerminal: true,
                logger: pino({ level: "info" }).child({ level: "info" }),
                browser: Browsers.windows("Chrome"),
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
                emitOwnEvents: true,
                fireInitQueries: true,
            });

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin, qr } = update;

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
                    console.log("✅ Connected successfully!");
                    
                    await delay(3000);
                    
                    if (!sessionSaved) {
                        console.log("📱 Saving QR session folder to MongoDB...");
                        
                        try {
                            const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || `qr_${sessionId}`;
                            
                            const result = await saveSessionFolder(phoneNumber, 'qr', sessionFolder);
                            
                            console.log("✅ QR session folder saved to MongoDB!");
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
                            
                            // Clean up local files
                            setTimeout(() => {
                                removeFile(sessionFolder);
                                console.log("🧹 Cleaned up local temp files");
                            }, 5000);
                            
                        } catch (error) {
                            console.error("❌ Error saving QR session:", error);
                        }
                    }
                    
                    // Keep connection alive
                    setInterval(async () => {
                        if (isConnectionOpen) {
                            try {
                                await KnightBot.sendPresenceUpdate('available');
                                console.log("💓 Keep-alive ping sent");
                            } catch (pingError) {
                                console.error("Keep-alive error:", pingError);
                            }
                        }
                    }, 30000);
                }

                if (connection === "close") {
                    isConnectionOpen = false;
                    console.log("🔌 Connection closed");
                    
                    if (!sessionSaved) {
                        removeFile(sessionFolder);
                        console.log("🧹 Cleaned up unsaved QR session files");
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ code: "QR generation timeout" });
                    removeFile(sessionFolder);
                }
            }, 45000);

        } catch (err) {
            console.error("❌ Error initializing session:", err);
            if (!responseSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(sessionFolder);
        }
    }

    await initiateSession();
});

export default router;
