// In qr.js - use the same working logic as your old pair.js
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
    const dirs = `./sessions/qr_${sessionId}`;
    
    // Create directory
    if (!fs.existsSync("./sessions")) {
        fs.mkdirSync("./sessions", { recursive: true });
    }
    
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
                
                // Generate QR code
                if (qr && !responseSent) {
                    console.log(`🟢 QR Code Generated`);
                    
                    try {
                        const qrDataURL = await QRCode.toDataURL(qr);
                        
                        if (!responseSent) {
                            responseSent = true;
                            res.send({ 
                                qr: qrDataURL,
                                message: "Scan QR code with WhatsApp"
                            });
                        }
                    } catch (qrError) {
                        console.error("QR error:", qrError);
                        if (!responseSent) {
                            responseSent = true;
                            res.status(500).send({ code: "QR generation failed" });
                        }
                    }
                }
                
                if (connection === "open") {
                    connectedNumber = KnightBot.authState.creds.me?.id?.split(':')[0];
                    console.log(`✅ ${connectedNumber}: Connected via QR!`);
                    
                    try {
                        const credsPath = dirs + "/creds.json";
                        if (fs.existsSync(credsPath)) {
                            const credentials = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                            
                            await sessionDB.saveSession({
                                phoneNumber: connectedNumber,
                                sessionType: 'qr',
                                credentials: credentials,
                            });
                            
                            console.log(`💾 ${connectedNumber}: Session saved`);
                        }
                    } catch (error) {
                        console.error("Save error:", error);
                    }
                    
                    removeFile(dirs);
                }
                
                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`🔌 QR session closed: ${statusCode}`);
                    removeFile(dirs);
                }
            });
            
            KnightBot.ev.on("creds.update", saveCreds);
            
            // Timeout after 2 minutes
            setTimeout(() => {
                if (!connectedNumber && !responseSent) {
                    responseSent = true;
                    res.status(408).send({ code: "QR timeout" });
                    removeFile(dirs);
                }
            }, 120000);
            
        } catch (err) {
            console.error("QR session error:", err);
            if (!responseSent) {
                responseSent = true;
                res.status(500).send({ code: "Service error" });
            }
            removeFile(dirs);
        }
    }
    
    await initiateSession();
});

export default router;
