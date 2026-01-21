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
import { sessionDB } from "./database.js";

const router = express.Router();

// Helper function to remove directory
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

// Main QR route
router.get("/", async (req, res) => {
    try {
        const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        const dirs = `./sessions/qr_${sessionId}`;

        // Create directory for QR session
        if (!fs.existsSync("./sessions")) {
            fs.mkdirSync("./sessions", { recursive: true });
        }

        // Remove existing directory
        await removeFile(dirs);
        fs.mkdirSync(dirs, { recursive: true });

        console.log(`📱 Starting QR session: ${sessionId}`);

        let responseSent = false;
        let connectedNumber = null;

        async function initiateSession() {
            const { state, saveCreds } = await useMultiFileAuthState(dirs);

            try {
                const { version } = await fetchLatestBaileysVersion();

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

                KnightBot.ev.on("connection.update", async (update) => {
                    const { connection, lastDisconnect, isNewLogin, isOnline, qr } = update;

                    // Generate and send QR code
                    if (qr && !responseSent) {
                        console.log(`🟢 QR Code Generated for session: ${sessionId}`);

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

                                res.send({
                                    success: true,
                                    sessionId: sessionId,
                                    qr: qrDataURL,
                                    message: "Scan this QR code with your WhatsApp app",
                                    instructions: [
                                        "1. Open WhatsApp on your phone",
                                        "2. Go to Settings > Linked Devices",
                                        '3. Tap "Link a Device"',
                                        "4. Tap \"Scan QR Code\"",
                                        "5. Scan the QR code above",
                                        "6. Wait for connection confirmation"
                                    ],
                                    note: "Your session will be automatically saved to the cloud"
                                });

                                console.log(`📱 QR code sent to client for session: ${sessionId}`);
                            }
                        } catch (qrError) {
                            console.error("❌ Error generating QR code:", qrError);

                            if (!responseSent) {
                                responseSent = true;
                                res.status(500).send({
                                    success: false,
                                    message: "Failed to generate QR code"
                                });
                            }
                        }
                    }

                    // When connection is established
                    if (connection === "open") {
                        connectedNumber = KnightBot.authState.creds.me?.id?.split(':')[0];

                        if (connectedNumber) {
                            console.log(`✅ ${connectedNumber}: Connected successfully via QR!`);

                            try {
                                // Read credentials from file
                                const credsPath = dirs + "/creds.json";
                                if (fs.existsSync(credsPath)) {
                                    const credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

                                    // Save to MongoDB
                                    await sessionDB.saveSession({
                                        phoneNumber: connectedNumber,
                                        sessionType: 'qr',
                                        credentials: credentials,
                                        deviceInfo: {
                                            platform: 'web',
                                            browser: 'Chrome',
                                            userAgent: req.headers['user-agent'] || 'Unknown'
                                        }
                                    });

                                    console.log(`💾 ${connectedNumber}: Session saved to MongoDB`);

                                    // Send success message to user
                                    const userJid = jidNormalizedUser(connectedNumber + "@s.whatsapp.net");

                                    await KnightBot.sendMessage(userJid, {
                                        text: `✅ *SESSION SAVED SUCCESSFULLY!*\n\n📱 Your WhatsApp bot is now connected via QR code!\n\n🔑 Session ID: ${connectedNumber}\n⏰ Expires: 90 days\n\n📊 *Bot Features:*\n• Auto-reply messages\n• Group management\n• Media downloader\n• And much more!\n\nType *.menu* to see all commands.`
                                    });

                                    console.log(`📩 ${connectedNumber}: Welcome message sent`);
                                }
                            } catch (saveError) {
                                console.error(`❌ ${connectedNumber}: Error saving session:`, saveError);
                            }
                        }

                        // Clean up local files
                        removeFile(dirs);
                    }

                    if (isNewLogin) {
                        console.log(`🔐 ${connectedNumber || sessionId}: New login via QR code`);
                    }

                    if (isOnline) {
                        console.log(`📶 ${connectedNumber || sessionId}: Client is online`);
                    }

                    if (connection === "close") {
                        const statusCode = lastDisconnect?.error?.output?.statusCode;

                        if (connectedNumber) {
                            if (statusCode === 401) {
                                console.log(`❌ ${connectedNumber}: Logged out from WhatsApp`);
                                await sessionDB.updateStatus(connectedNumber, 'inactive');
                            } else {
                                console.log(`🔌 ${connectedNumber}: Connection closed`);
                            }
                        }

                        // Clean up
                        removeFile(dirs);
                    }
                });

                KnightBot.ev.on("creds.update", saveCreds);

                // Timeout after 2 minutes if no QR scanned
                setTimeout(() => {
                    if (!connectedNumber && !responseSent) {
                        console.log(`⏰ QR session timeout: ${sessionId}`);

                        if (!responseSent) {
                            responseSent = true;
                            res.status(408).send({
                                success: false,
                                message: "QR code expired. Please try again."
                            });
                        }

                        removeFile(dirs);
                    }
                }, 120000);

            } catch (err) {
                console.error(`❌ ${sessionId}: Error initializing QR session:`, err);

                if (!responseSent) {
                    responseSent = true;
                    res.status(500).send({
                        success: false,
                        message: "Service Unavailable. Please try again later."
                    });
                }

                removeFile(dirs);
            }
        }

        // Start session initiation
        await initiateSession();

    } catch (error) {
        console.error("❌ QR route error:", error);

        if (!res.headersSent) {
            res.status(500).send({
                success: false,
                message: "Internal server error"
            });
        }
    }
});

// Export router
export default router;