// pair.js
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
    let num = req.query.number;
    
    // Create session folder with phone number
    const sessionFolder = `./temp_sessions/${num}`;
    await removeFile(sessionFolder);

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
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

        try {
            await connectDB();
            
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

            let isConnectionOpen = false;
            let sessionSaved = false;

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin } = update;

                console.log("🔧 Connection Update:", { connection, isNewLogin });

                if (connection === "open") {
                    isConnectionOpen = true;
                    console.log("✅ Connected successfully!");
                    
                    // Wait for all files to be created
                    await delay(3000);
                    
                    if (!sessionSaved) {
                        console.log("📱 Saving session folder to MongoDB...");
                        
                        try {
                            // Save entire session folder to MongoDB
                            const result = await saveSessionFolder(num, 'pair', sessionFolder);
                            
                            console.log("✅ Session folder saved to MongoDB!");
                            console.log(`📋 Session ID: ${result.sessionId}`);
                            console.log(`📁 Files saved: ${result.filesCount}`);
                            
                            // Send success message to user
                            const userJid = jidNormalizedUser(num + "@s.whatsapp.net");
                            try {
                                await KnightBot.sendMessage(userJid, {
                                    text: `✅ WhatsApp session saved successfully!\n\n📱 Phone: ${num}\n🔑 Session ID: ${result.sessionId}\n📁 Files: ${result.filesCount}\n\nYour session is now stored securely in the database with folder structure.`,
                                });
                                console.log("📄 Success message sent to user");
                            } catch (sendError) {
                                console.error("❌ Error sending message:", sendError);
                            }
                            
                            sessionSaved = true;
                            
                            // Clean up local temp files after saving to DB
                            setTimeout(() => {
                                removeFile(sessionFolder);
                                console.log("🧹 Cleaned up local temp files");
                            }, 5000);
                            
                        } catch (error) {
                            console.error("❌ Error saving session folder:", error);
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
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    console.log("🔌 Connection closed with status:", statusCode);
                    
                    // Clean up if session wasn't saved
                    if (!sessionSaved) {
                        removeFile(sessionFolder);
                        console.log("🧹 Cleaned up unsaved session files");
                    }
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

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
                }
            }

        } catch (err) {
            console.error("❌ Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(sessionFolder);
        }
    }

    await initiateSession();
});

export default router;
