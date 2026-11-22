const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

function cleanupSession(id) {
  if (sessions[id]) {
    try { sessions[id].sock?.end(); } catch (_) {}
    delete sessions[id];
  }
  try { fs.rmSync(`./auth_${id}`, { recursive: true, force: true }); } catch (_) {}
}

async function startSession(id) {
  if (sessions[id] && sessions[id].starting) return;

  // تنظيف الجلسات غير المرتبطة لتوفير الذاكرة في Render
  Object.keys(sessions).forEach((key) => {
    if (key !== id && !sessions[key].ready && Date.now() - sessions[key].createdAt > 120000) {
      cleanupSession(key);
    }
  });

  sessions[id] = { ready: false, qr: null, starting: true, error: null, createdAt: Date.now() };

  try {
    const authFolder = `./auth_${id}`;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      connectTimeoutMs: 30000
    });

    sessions[id].sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (!sessions[id]) return;

      if (qr) {
        sessions[id].qr = qr;
        sessions[id].ready = false;
        sessions[id].starting = false;
        sessions[id].createdAt = Date.now();
      }
      if (connection === 'open') {
        sessions[id].ready = true;
        sessions[id].qr = null;
        sessions[id].starting = false;
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        sessions[id].ready = false;
        sessions[id].starting = false;
        sessions[id].qr = null;
        if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 408) {
          cleanupSession(id);
        } else {
          setTimeout(() => {
            if (sessions[id]) startSession(id);
          }, 2000);
        }
      }
    });
  } catch (err) {
    if (sessions[id]) {
      sessions[id].error = err.message;
      sessions[id].starting = false;
    }
  }
}

app.get('/', (req, res) => res.send('WA Cloud Server Running'));

app.get('/qr', async (req, res) => {
  const id = (req.query.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  if (req.query.reset === '1') {
    cleanupSession(id);
  }
  if (!sessions[id] || (!sessions[id].ready && !sessions[id].qr && !sessions[id].starting)) {
    startSession(id);
  }
  const s = sessions[id] || { ready: false, qr: null };
  res.json({ ready: s.ready, qr: s.qr, error: s.error || null });
});

app.get('/logout', (req, res) => {
  const id = (req.query.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  cleanupSession(id);
  res.json({ success: true });
});

app.post('/send-bulk', async (req, res) => {
  const id = (req.query.id || req.body.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const { messages } = req.body;
  const s = sessions[id];
  if (!s || !s.ready || !s.sock) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  const results = [];
  for (const item of (messages || [])) {
    try {
      let phone = String(item.phone).replace(/\D/g, '');
      if (phone.startsWith('05')) phone = '966' + phone.slice(1);
      const jid = `${phone}@s.whatsapp.net`;
      await s.sock.sendMessage(jid, { text: item.message });
      results.push({ phone, status: 'sent' });
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      results.push({ phone: item.phone, status: 'failed', error: e.message });
    }
  }
  res.json({ success: true, results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
