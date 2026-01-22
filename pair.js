// pair.js
import express from "express";
import fs from "fs";
import pino from "pino";
import mongoose from "mongoose";
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
            // Connect to MongoDB
            await connectDB();
            
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

            let isConnectionOpen = false;

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin, isOnline } =
                    update;

                if (connection === "open") {
                    isConnectionOpen = true;
                    console.log("✅ Connected successfully!");
                    console.log("📱 Saving session to MongoDB...");

                    try {
                        // Read creds.json file
                        const credsPath = dirs + "/creds.json";
                        if (fs.existsSync(credsPath)) {
                            const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            
                            // Create session ID
                            const mongoSessionId = `pair_${num}_${Date.now()}`;
                            
                            // Save to MongoDB
                            const sessionDoc = new Session({
                                sessionId: mongoSessionId,
                                phoneNumber: num,
                                type: 'pair',
                                credentials: credsData
                            });
                            
                            await sessionDoc.save();
                            
                            console.log("✅ Session saved to MongoDB. Session ID:", mongoSessionId);

                            const userJid = jidNormalizedUser(
                                num + "@s.whatsapp.net",
                            );

                            await KnightBot.sendMessage(userJid, {
                                text: mongoSessionId,
                            });
                            console.log("📄 Session ID sent successfully");
                        } else {
                            console.log("❌ Creds file not found");
                        }
                    } catch (error) {
                        console.error("❌ Error saving to MongoDB:", error);
                    }
                    
                    // Clean up local files
                    await removeFile(dirs);
                }

                if (connection === "close") {
                    isConnectionOpen = false;
                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log(
                            "❌ Logged out from WhatsApp. Need to generate new pair code.",
                        );
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        // Don't restart automatically
                    }
                }

                if (isNewLogin) {
                    console.log("🔐 New login via pair code");
                }

                if (isOnline) {
                    console.log("📶 Client is online");
                }
            });

            KnightBot.ev.on("creds.update", async (creds) => {
                saveCreds(creds);
                
                // Update MongoDB when creds are updated
                if (isConnectionOpen) {
                    try {
                        const credsPath = dirs + "/creds.json";
                        if (fs.existsSync(credsPath)) {
                            const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            
                            await Session.findOneAndUpdate(
                                { phoneNumber: num, type: 'pair' },
                                { 
                                    credentials: credsData,
                                    lastUpdated: new Date()
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

            // Handle process cleanup
            process.on('beforeExit', () => {
                removeFile(dirs);
            });

        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
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
    if (
        e.includes("Stream Errored") ||
        e.includes("Stream Errored (restart required)")
    )
        return;
    if (e.includes("statusCode: 515") || e.includes("statusCode: 503")) return;
    console.log("Caught exception: ", err);
    // Don't exit process
});

export default router;
