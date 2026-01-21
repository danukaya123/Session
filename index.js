import express from "express";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
import { connectDB } from "./database.js";

import pairRouter from "./pair.js";
import qrRouter from "./qr.js";

// Load environment variables
dotenv.config();

// Connect to MongoDB
connectDB();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 5000;

// Increase event listeners limit
import("events").then((events) => {
    events.EventEmitter.defaultMaxListeners = 500;
});

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Routes
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "pair.html"));
});

app.use("/pair", pairRouter);
app.use("/qr", qrRouter);

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({
        status: "OK",
        message: "Session Generator is running",
        mongodb: "Connected",
    });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ Session Generator running on http://0.0.0.0:${PORT}`);
    console.log(`📊 MongoDB connected for session storage`);
});

export default app;
