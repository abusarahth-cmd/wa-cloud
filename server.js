const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};
const IDLE_TIMEOUT = 3 * 60 * 1000;

function resetIdleTimer(sessionId) {
    if (sessions[sessionId]?.timer) clearTimeout(sessions[sessionId].timer);
    sessions[sessionId].timer = setTimeout(() => {
        if (sessions[sessionId]?.sock) {
            sessions[sessionId].sock.end();
            delete sessions[sessionId];
        }
    }, IDLE_TIMEOUT);
}

async function initSession(sessionId) {
    if (sessions[sessionId]?.sock) {
        resetIdleTimer(sessionId);
        return;
    }
    sessions[sessionId] = { qr: null, ready: false, sock: null, timer: null };

    const { state, saveCreds } = await useMultiFileAuthState(`./auth_${sessionId}`);
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    sessions[sessionId].sock = sock;
    resetIdleTimer(sessionId);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            sessions[sessionId].qr = await QRCode.toDataURL(qr);
            sessions[sessionId].ready = false;
        }
        if (connection === 'open') {
            sessions[sessionId].ready = true;
            sessions[sessionId].qr = null;
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === DisconnectReason.loggedOut) {
                fs.rmSync(`./auth_${sessionId}`, { recursive: true, force: true });
                delete sessions[sessionId];
            } else if (sessions[sessionId]) {
                sessions[sessionId].ready = false;
                sessions[sessionId].sock = null;
            }
        }
    });
}

app.get('/', (req, res) => res.send('WA Cloud Scalable Server Active'));

app.get('/qr', async (req, res) => {
    const sessionId = req.query.id || 'default';
    await initSession(sessionId);
    res.json({ ready: sessions[sessionId]?.ready || false, qr: sessions[sessionId]?.qr || null });
});

app.post('/send-bulk', async (req, res) => {
    const sessionId = req.query.id || 'default';
    await initSession(sessionId);

    for (let i = 0; i < 16; i++) {
        if (sessions[sessionId]?.ready) break;
        await new Promise(r => setTimeout(r, 500));
    }

    const session = sessions[sessionId];
    if (!session?.ready) return res.status(400).json({ error: 'يرجى مسح الباركود أولاً' });

    resetIdleTimer(sessionId);
    const { messages } = req.body;
    for (const msg of messages) {
        const jid = msg.phone.replace(/\D/g, '') + '@s.whatsapp.net';
        await session.sock.sendMessage(jid, { text: msg.text });
        await new Promise(r => setTimeout(r, 1500));
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Scalable WA Server running on', PORT));
