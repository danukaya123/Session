// index.js (updated)
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import path from "path";

import pairRouter from "./pair.js";
import qrRouter from "./qr.js";
import { connectDB } from "./db.js";


const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;

import("events").then((events) => {
    events.EventEmitter.defaultMaxListeners = 500;
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Initialize MongoDB connection with error handling
connectDB().then(() => {
    console.log('✅ Database connection established');
}).catch(err => {
    console.error('❌ Failed to connect to database:', err);
    console.log('⚠️  Server will continue running, but database features may not work');
});

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "pair.html"));
});

app.use("/pair", pairRouter);
app.use("/qr", qrRouter);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        success: false, 
        message: 'Internal Server Error',
        error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
    console.log(`📱 Pair Code endpoint: http://0.0.0.0:${PORT}/pair`);
    console.log(`🔗 QR Code endpoint: http://0.0.0.0:${PORT}/qr`);
});

export default app;
