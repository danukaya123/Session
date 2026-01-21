# DANUWA-MD - WhatsApp Pair Code Generator

## Overview
DANUWA-MD is a WhatsApp pairing tool that allows users to link their WhatsApp devices using either a pair code or QR code method. The application uploads session credentials to MEGA cloud storage.

## Project Structure
```
/
├── index.js        # Main Express server entry point
├── pair.js         # Pair code generation route handler
├── qr.js           # QR code generation route handler
├── mega.js         # MEGA cloud storage upload/download utilities
├── pair.html       # Frontend HTML interface
└── package.json    # Node.js dependencies and scripts
```

## Technology Stack
- **Runtime**: Node.js 20
- **Framework**: Express.js
- **WhatsApp API**: @whiskeysockets/baileys
- **Cloud Storage**: MEGA.js
- **QR Code**: qrcode library

## Running the Application
- **Port**: 5000 (bound to 0.0.0.0 for Replit compatibility)
- **Start command**: `npm start`

## Routes
- `GET /` - Serves the main HTML interface
- `GET /pair?number=<phone>` - Generates a WhatsApp pair code for the given phone number
- `GET /qr` - Generates a WhatsApp QR code for scanning

## Dependencies
- @whiskeysockets/baileys - WhatsApp Web API
- express - Web framework
- body-parser - Request body parsing
- megajs - MEGA cloud storage SDK
- qrcode - QR code generation
- awesome-phonenumber - Phone number validation
- pino - Logging

## Notes
- The application uses ES Modules (type: "module" in package.json)
- Phone numbers should be entered with country code (e.g., +1234567890)
- Session credentials are automatically uploaded to MEGA after successful pairing
