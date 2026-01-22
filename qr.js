// qr.js
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
            
            const { version, isLatest } = await fetchLatestBaileysVersion();

            let responseSent = false;
            let isConnectionOpen = false;

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
                const { connection, lastDisconnect, isNewLogin, isOnline, qr } =
                    update;

                // Update connection status
                if (connection === "open") {
                    isConnectionOpen = true;
                    console.log("✅ Connected successfully!");
                    console.log("📱 Saving session to MongoDB...");

                    try {
                        const credsPath = dirs + "/creds.json";
                        if (fs.existsSync(credsPath)) {
                            const credsData = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || 'qr_session';
                            
                            // Save to MongoDB
                            const mongoSessionId = `qr_${sessionId}`;
                            const sessionDoc = new Session({
                                sessionId: mongoSessionId,
                                phoneNumber: phoneNumber,
                                type: 'qr',
                                credentials: credsData
                            });
                            
                            await sessionDoc.save();
                            
                            console.log("✅ Session saved to MongoDB. Session ID:", mongoSessionId);

                            const userJid = jidNormalizedUser(
                                KnightBot.authState.creds.me?.id || "",
                            );
                            if (userJid) {
                                await KnightBot.sendMessage(userJid, {
                                    text: mongoSessionId,
                                });
                                console.log(
                                    "📄 Session ID sent successfully",
                                );
                            } else {
                                console.log("❌ Could not determine user JID");
                            }
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
                            "❌ Logged out from WhatsApp. Need to generate new QR code.",
                        );
                    } else {
                        console.log("🔁 Connection closed — restarting...");
                        // Don't restart automatically to avoid infinite loops
                    }
                }

                if (qr && !responseSent) {
                    console.log(
                        "🟢 QR Code Generated! Scan it with your WhatsApp app.",
                    );

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
                                message:
                                    "QR Code Generated! Scan it with your WhatsApp app.",
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

                if (isNewLogin) {
                    console.log("🔐 New login via QR code");
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
                            const phoneNumber = KnightBot.authState.creds.me?.id?.split(':')[0] || 'qr_session';
                            
                            await Session.findOneAndUpdate(
                                { sessionId: `qr_${sessionId}` },
                                { 
                                    credentials: credsData, 
                                    phoneNumber: phoneNumber,
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

            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;
                    res.status(408).send({ code: "QR generation timeout" });
                    removeFile(dirs);
                    // Don't exit process, just clean up
                }
            }, 30000);

            // Handle process cleanup
            process.on('beforeExit', () => {
                removeFile(dirs);
            });

        } catch (err) {
            console.error("Error initializing session:", err);
            if (!responseSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(dirs);
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
    // Don't exit process for uncaught exceptions in this context
});

export default router;
