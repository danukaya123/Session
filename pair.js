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

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin } = update;

                console.log("🔧 Connection Update:", { connection, isNewLogin });

                if (connection === "open") {
                    isConnectionOpen = true;
                    console.log("✅ Connected successfully!");
                    
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
                            
                            const mongoSessionId = `pair_${num}_${Date.now()}`;
                            const sessionDoc = new Session({
                                sessionId: mongoSessionId,
                                phoneNumber: num,
                                type: 'pair',
                                credentials: credsData,
                                status: 'active'
                            });
                            
                            await sessionDoc.save();
                            console.log("✅ Session saved to MongoDB. Session ID:", mongoSessionId);

                            const userJid = jidNormalizedUser(num + "@s.whatsapp.net");
                            try {
                                await KnightBot.sendMessage(userJid, {
                                    text: `Session ID: ${mongoSessionId}\nYour WhatsApp session has been paired successfully!`,
                                });
                                console.log("📄 Session ID sent successfully");
                            } catch (sendError) {
                                console.error("❌ Error sending message:", sendError);
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
                            
                        } else {
                            console.log("❌ Creds file not found after waiting");
                        }
                    } catch (error) {
                        console.error("❌ Error saving to MongoDB:", error);
                    }
                    
                    console.log("📁 Session files kept for reconnection");
                }

                if (connection === "close") {
                    isConnectionOpen = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const error = lastDisconnect?.error;
                    
                    console.log("🔌 Connection closed:", {
                        statusCode,
                        error: error?.message || error
                    });

                    if (statusCode === 401) {
                        console.log("❌ Logged out from WhatsApp.");
                        removeFile(dirs);
                    } else {
                        console.log("⚠️ Connection lost. Will try to reconnect...");
                        setTimeout(() => {
                            if (!isConnectionOpen) {
                                console.log("🔄 Attempting to reconnect...");
                                initiateSession();
                            }
                        }, 5000);
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }
            });

            KnightBot.ev.on("creds.update", async (creds) => {
                saveCreds(creds);
                
                if (isConnectionOpen) {
                    try {
                        const credsPath = dirs + "/creds.json";
                        if (fs.existsSync(credsPath)) {
                            const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            
                            await Session.findOneAndUpdate(
                                { phoneNumber: num, type: 'pair' },
                                { 
                                    credentials: credsData,
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
        }
    }

    await initiateSession();
});

export default router;
