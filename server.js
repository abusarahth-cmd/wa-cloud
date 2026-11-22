const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const sessions = {};

async function startSession(id) {
  if (sessions[id] && sessions[id].starting) return;
  sessions[id] = { ready: false, qr: null, starting: true, error: null };

  try {
    const authFolder = `./auth_${id}`;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false
    });

    sessions[id].sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        sessions[id].qr = qr;
        sessions[id].ready = false;
        sessions[id].starting = false;
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
        if (statusCode === DisconnectReason.loggedOut) {
          fs.rmSync(authFolder, { recursive: true, force: true });
          delete sessions[id];
        } else {
          setTimeout(() => startSession(id), 3000);
        }
      }
    });
  } catch (err) {
    sessions[id].error = err.message;
    sessions[id].starting = false;
  }
}

app.get('/', (req, res) => res.send('WA Cloud Server Running'));

app.get('/qr', async (req, res) => {
  const id = (req.query.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!sessions[id]) {
    startSession(id);
  }
  const s = sessions[id] || { ready: false, qr: null };
  res.json({ ready: s.ready, qr: s.qr, error: s.error || null });
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
