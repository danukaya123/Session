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

// Helper function to remove directory
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

// Main pair route
router.get("/", async (req, res) => {
    try {
        let num = req.query.number;

        if (!num) {
            return res.status(400).send({
                success: false,
                message: "Phone number is required",
            });
        }

        // Clean the number
        num = num.replace(/[^0-9]/g, "");

        // Validate phone number
        const phone = pn("+" + num);
        if (!phone.isValid()) {
            return res.status(400).send({
                success: false,
                message:
                    "Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces.",
            });
        }

        num = phone.getNumber("e164").replace("+", "");
        console.log(`📱 Processing pair request for: ${num}`);

        // Check if session already exists
        const existingSession = await sessionDB.getSession(num);
        if (existingSession) {
            return res.status(409).send({
                success: false,
                message:
                    "Session already exists for this number. Please delete it first or use a different number.",
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

        async function initiateSession() {
            const { state, saveCreds } = await useMultiFileAuthState(dirs);

            try {
                const { version } = await fetchLatestBaileysVersion();

                let KnightBot = makeWASocket({
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
                    const { connection, lastDisconnect, isNewLogin, isOnline } =
                        update;

                    if (connection === "open") {
                        console.log(
                            `✅ ${num}: Connected successfully via pair code!`,
                        );

                        try {
                            // Read credentials from file
                            const credsPath = dirs + "/creds.json";
                            if (fs.existsSync(credsPath)) {
                                const credentials = JSON.parse(
                                    fs.readFileSync(credsPath, "utf8"),
                                );

                                // Save to MongoDB
                                await sessionDB.saveSession({
                                    phoneNumber: num,
                                    sessionType: "pair",
                                    credentials: credentials,
                                    deviceInfo: {
                                        platform: "web",
                                        browser: "Chrome",
                                        userAgent:
                                            req.headers["user-agent"] ||
                                            "Unknown",
                                    },
                                });

                                console.log(
                                    `💾 ${num}: Session saved to MongoDB`,
                                );

                                // Send success message to user
                                const userJid = jidNormalizedUser(
                                    num + "@s.whatsapp.net",
                                );

                                await KnightBot.sendMessage(userJid, {
                                    text: `✅ *SESSION SAVED SUCCESSFULLY!*\n\n📱 Your WhatsApp bot is now connected!\n\n🔑 Session ID: ${num}\n⏰ Expires: 90 days\n\n📊 *Bot Features:*\n• Auto-reply messages\n• Group management\n• Media downloader\n• And much more!\n\nType *.menu* to see all commands.`,
                                });

                                console.log(`📩 ${num}: Welcome message sent`);
                            }
                        } catch (saveError) {
                            console.error(
                                `❌ ${num}: Error saving session:`,
                                saveError,
                            );
                        }

                        // Clean up local files
                        removeFile(dirs);
                    }

                    if (isNewLogin) {
                        console.log(`🔐 ${num}: New login via pair code`);
                    }

                    if (isOnline) {
                        console.log(`📶 ${num}: Client is online`);
                    }

                    if (connection === "close") {
                        const statusCode =
                            lastDisconnect?.error?.output?.statusCode;

                        if (statusCode === 401) {
                            console.log(`❌ ${num}: Logged out from WhatsApp`);
                            await sessionDB.updateStatus(num, "inactive");
                        } else {
                            console.log(`🔌 ${num}: Connection closed`);
                        }
                    }
                });

                // Request pairing code if not registered
                if (!KnightBot.authState.creds.registered) {
                    await delay(3000);

                    try {
                        let code = await KnightBot.requestPairingCode(num);
                        code = code?.match(/.{1,4}/g)?.join("-") || code;

                        if (!responseSent) {
                            responseSent = true;

                            res.send({
                                success: true,
                                phoneNumber: num,
                                pairingCode: code,
                                message:
                                    "Use this pairing code in your WhatsApp app",
                                instructions: [
                                    "1. Open WhatsApp on your phone",
                                    "2. Go to Settings > Linked Devices",
                                    '3. Tap "Link a Device"',
                                    "4. Enter this code: " + code,
                                    "5. Wait for connection confirmation",
                                ],
                                note: "Your session will be automatically saved to the cloud",
                            });

                            console.log(
                                `📟 ${num}: Pairing code generated: ${code}`,
                            );
                        }
                    } catch (error) {
                        console.error(
                            `❌ ${num}: Error requesting pairing code:`,
                            error,
                        );

                        if (!responseSent) {
                            responseSent = true;
                            res.status(503).send({
                                success: false,
                                message:
                                    "Failed to get pairing code. Please check your phone number and try again.",
                            });
                        }

                        removeFile(dirs);
                    }
                }

                KnightBot.ev.on("creds.update", saveCreds);
            } catch (err) {
                console.error(`❌ ${num}: Error initializing session:`, err);

                if (!responseSent) {
                    responseSent = true;
                    res.status(500).send({
                        success: false,
                        message: "Service Unavailable. Please try again later.",
                    });
                }

                removeFile(dirs);
            }
        }

        // Start session initiation
        await initiateSession();
    } catch (error) {
        console.error("❌ Pair route error:", error);

        if (!res.headersSent) {
            res.status(500).send({
                success: false,
                message: "Internal server error",
            });
        }
    }
});

// Export router
export default router;
