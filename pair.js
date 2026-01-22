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
    let num = req.query.number;
    const dirs = `./pair_sessions/${num}`;

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

    let responseSent = false; // Moved outside

    async function initiateSession(reconnectAttempt = 0) {
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

            let isConnectionOpen = false;
            let sessionSaved = false;
            const maxReconnectAttempts = 3;

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin } = update;

                console.log("🔧 Connection Update:", { 
                    connection, 
                    isNewLogin,
                    reconnectAttempt 
                });

                if (connection === "open") {
                    isConnectionOpen = true;
                    reconnectAttempt = 0; // Reset on successful connection
                    console.log("✅ Connected successfully!");
                    
                    await delay(3000);
                    
                    if (!sessionSaved) {
                        console.log("📱 Saving creds.json to MongoDB...");
                        
                        try {
                            const credsPath = `${dirs}/creds.json`;
                            
                            if (fs.existsSync(credsPath)) {
                                const fileData = fs.readFileSync(credsPath);
                                
                                const timestamp = Date.now();
                                const uniqueFileName = `${timestamp}_creds.json`;
                                const virtualPath = `sessions/${num}/creds.json`;
                                
                                const sessionFile = new SessionFile({
                                    phoneNumber: num,
                                    fileName: uniqueFileName,
                                    filePath: virtualPath,
                                    fileData,
                                    fileType: 'creds',
                                    sessionType: 'pair'
                                });
                                
                                await sessionFile.save();
                                console.log(`📁 Saved: creds.json as ${uniqueFileName}`);
                                
                                const mongoSessionId = `pair_${num}_${Date.now()}`;
                                const sessionMeta = new SessionMeta({
                                    sessionId: mongoSessionId,
                                    phoneNumber: num,
                                    type: 'pair',
                                    status: 'active'
                                });
                                
                                await sessionMeta.save();
                                
                                console.log(`✅ Saved creds.json to MongoDB`);
                                console.log(`📋 Session ID: ${mongoSessionId}`);
                                
                                sessionSaved = true;
                                
                                // Send confirmation
                                try {
                                    const userJid = jidNormalizedUser(num + "@s.whatsapp.net");
                                    await KnightBot.sendMessage(userJid, {
                                        text: `✅ WhatsApp session saved successfully!\n\n📱 Phone: ${num}\n🔑 Session ID: ${mongoSessionId}\n\nYour session is now stored securely in the database.`,
                                    });
                                    console.log("📄 Confirmation sent");
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
                                
                                // Clean up after saving
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

                if (connection === "close") {
                    isConnectionOpen = false;
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    
                    console.log("🔌 Connection closed with status:", statusCode);
                    
                    // Try to reconnect for pairing code sessions too
                    if (!sessionSaved && reconnectAttempt < maxReconnectAttempts) {
                        reconnectAttempt++;
                        console.log(`🔄 Reconnection attempt ${reconnectAttempt}/${maxReconnectAttempts} for pair session`);
                        
                        setTimeout(async () => {
                            try {
                                console.log("🔄 Attempting to reconnect pair session...");
                                await initiateSession(reconnectAttempt);
                            } catch (reconnectError) {
                                console.error("❌ Reconnection failed:", reconnectError.message);
                                
                                // Try to save creds.json anyway
                                const credsPath = `${dirs}/creds.json`;
                                if (fs.existsSync(credsPath)) {
                                    try {
                                        console.log("🔄 Trying to save creds.json after failed reconnection...");
                                        const fileData = fs.readFileSync(credsPath);
                                        
                                        const timestamp = Date.now();
                                        const uniqueFileName = `${timestamp}_creds_emergency.json`;
                                        
                                        const sessionFile = new SessionFile({
                                            phoneNumber: num,
                                            fileName: uniqueFileName,
                                            filePath: `sessions/${num}/emergency/creds.json`,
                                            fileData,
                                            fileType: 'creds',
                                            sessionType: 'pair'
                                        });
                                        
                                        await sessionFile.save();
                                        console.log("✅ Emergency backup of creds.json saved");
                                        
                                    } catch (emergencyError) {
                                        console.error("❌ Emergency backup failed:", emergencyError.message);
                                    }
                                }
                                
                                // Clean up
                                setTimeout(() => {
                                    removeFile(dirs);
                                    console.log("🧹 Cleaned up pair session files");
                                }, 5000);
                            }
                        }, 2000);
                    } else if (sessionSaved) {
                        console.log("✅ Pair session already saved");
                        setTimeout(() => {
                            removeFile(dirs);
                            console.log("🧹 Cleaned up local files");
                        }, 5000);
                    } else {
                        console.log("❌ Max reconnection attempts reached for pair session");
                        setTimeout(() => {
                            removeFile(dirs);
                            console.log("🧹 Cleaned up unsaved pair session files");
                        }, 5000);
                    }
                }
            });

            KnightBot.ev.on("creds.update", saveCreds);

            if (!KnightBot.authState.creds.registered) {
                await delay(3000);
                let tempNum = num.replace(/[^\d+]/g, "");
                if (tempNum.startsWith("+")) tempNum = tempNum.substring(1);

                try {
                    let code = await KnightBot.requestPairingCode(tempNum);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    if (!responseSent) {
                        console.log({ num, code });
                        responseSent = true;
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error("Error requesting pairing code:", error);
                    if (!responseSent) {
                        responseSent = true;
                        res.status(503).send({
                            code: "Failed to get pairing code. Please check your phone number and try again.",
                        });
                    }
                }
            }

        } catch (err) {
            console.error("❌ Error initializing session:", err);
            if (!responseSent) {
                responseSent = true;
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;
