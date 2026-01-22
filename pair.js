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

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

router.get("/", async (req, res) => {
    let num = req.query.number;
    let dirs = "./" + (num || `session`);

    await removeFile(dirs);

    num = num.replace(/[^0-9]/g, "");

    const phone = pn("+" + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({
                code: "Invalid phone number. Please enter your full international number (e.g., 15551234567 for US, 447911123456 for UK, 84987654321 for Vietnam, etc.) without + or spaces.",
            });
        }
        return;
    }
    num = phone.getNumber("e164").replace("+", "");

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version, isLatest } = await fetchLatestBaileysVersion();
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
                    console.log("✅ Connected successfully!");
                    console.log("📱 Saving session to MongoDB...");

                    try {
                        // Read credentials from file
                        const credsPath = dirs + "/creds.json";
                        if (fs.existsSync(credsPath)) {
                            const credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            
                            // Save to MongoDB
                            const savedSession = await sessionDB.saveSession({
                                phoneNumber: num,
                                sessionType: 'pair',
                                credentials: credentials,
                                deviceInfo: {
                                    platform: 'web',
                                    browser: 'Chrome',
                                    userAgent: req.headers['user-agent'] || 'Unknown'
                                }
                            });
                            
                            console.log("✅ Session saved to MongoDB with ID:", savedSession._id);
                            console.log("📄 Document saved in 'sessions' collection");

                            // Send confirmation
                            const userJid = jidNormalizedUser(
                                num + "@s.whatsapp.net",
                            );

                            await KnightBot.sendMessage(userJid, {
                                text: `✅ Session saved successfully!\n\nSession ID: ${num}\nMongoDB ID: ${savedSession._id}\n\nYour bot will now connect automatically.`,
                            });
                            console.log("📩 Confirmation sent to user");
                            
                            // IMPORTANT: Don't close immediately, wait 10 seconds
                            setTimeout(() => {
                                console.log("🔄 Closing connection gracefully...");
                                // End connection properly
                                KnightBot.end(undefined);
                                // Clean up files
                                removeFile(dirs);
                            }, 10000);
                        }
                    } catch (error) {
                        console.error("❌ Error saving to MongoDB:", error);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }

                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    console.log(`🔌 Connection closed with status: ${statusCode}`);
                    
                    // DON'T restart session if it was a successful connection
                    // Only restart if it's an actual error (not 0 or undefined)
                    if (statusCode && statusCode !== 0 && statusCode !== 401) {
                        console.log("🔁 Error detected - restarting...");
                        // Don't actually restart - just log
                        // initiateSession();
                    }
                }
            });

            if (!KnightBot.authState.creds.registered) {
                await delay(3000);
                num = num.replace(/[^\d+]/g, "");
                if (num.startsWith("+")) num = num.substring(1);

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error("Error requesting pairing code:", error);
                    if (!res.headersSent) {
                        res.status(503).send({
                            code: "Failed to get pairing code. Please check your phone number and try again.",
                        });
                    }
                    setTimeout(() => process.exit(1), 2000);
                }
            }

            KnightBot.ev.on("creds.update", saveCreds);
        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            setTimeout(() => process.exit(1), 2000);
        }
    }

    await initiateSession();
});

process.on("uncaughtException", (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored") || e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515") || e.includes("statusCode: 503")) return;
    console.log("Caught exception: ", err);
    process.exit(1);
});

export default router;
