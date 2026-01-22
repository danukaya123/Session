// pair.js - SIMPLIFIED
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

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect, isNewLogin } = update;

                console.log("🔧 Connection Update:", { connection, isNewLogin });

                if (connection === "open") {
                    isConnectionOpen = true;
                    console.log("✅ Connected successfully!");
                    
                    await delay(3000);
                    
                    console.log("📱 Saving session files to MongoDB...");
                    
                    try {
                        const files = fs.readdirSync(dirs);
                        let savedFiles = 0;
                        
                        for (const fileName of files) {
                            const filePath = `${dirs}/${fileName}`;
                            const stats = fs.statSync(filePath);
                            
                            if (stats.isFile()) {
                                const fileData = fs.readFileSync(filePath);
                                
                                let fileType = 'other';
                                if (fileName === 'creds.json') fileType = 'creds';
                                else if (fileName.includes('auth')) fileType = 'auth';
                                
                                const timestamp = Date.now();
                                const uniqueFileName = `${timestamp}_${fileName}`;
                                const virtualPath = `sessions/${num}/${fileName}`;
                                
                                const sessionFile = new SessionFile({
                                    phoneNumber: num,
                                    fileName: uniqueFileName,
                                    filePath: virtualPath,
                                    fileData,
                                    fileType,
                                    sessionType: 'pair'
                                });
                                
                                await sessionFile.save();
                                savedFiles++;
                                console.log(`📁 Saved: ${fileName}`);
                            }
                        }
                        
                        const mongoSessionId = `pair_${num}_${Date.now()}`;
                        const sessionMeta = new SessionMeta({
                            sessionId: mongoSessionId,
                            phoneNumber: num,
                            type: 'pair',
                            status: 'active'
                        });
                        
                        await sessionMeta.save();
                        
                        console.log(`✅ Saved ${savedFiles} files`);
                        console.log(`📋 Session ID: ${mongoSessionId}`);
                        
                        // Send confirmation
                        try {
                            const userJid = jidNormalizedUser(num + "@s.whatsapp.net");
                            await KnightBot.sendMessage(userJid, {
                                text: `✅ WhatsApp session saved!\n\n📱 Phone: ${num}\n🔑 Session ID: ${mongoSessionId}\n📁 Files: ${savedFiles}`,
                            });
                            console.log("📄 Confirmation sent");
                        } catch (messageError) {
                            console.error("❌ Could not send message:", messageError.message);
                        }
                        
                    } catch (error) {
                        console.error("❌ Error saving to MongoDB:", error);
                    }
                }

                if (connection === "close") {
                    isConnectionOpen = false;
                    console.log("🔌 Connection closed");
                    
                    setTimeout(() => {
                        removeFile(dirs);
                        console.log("🧹 Cleaned up session files");
                    }, 5000);
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
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;
