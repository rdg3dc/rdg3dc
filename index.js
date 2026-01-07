const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

const sessions = new Map();

app.post('/api/get-qr', async (req, res) => {
  const { instance_id, token } = req.body;
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState(`./sessions/${instance_id}`);
    
    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { qr, connection } = update;
      
      if (qr) {
        const qrDataUrl = await QRCode.toDataURL(qr);
        sessions.set(instance_id, { sock, qr: qrDataUrl, status: 'pending' });
      }
      
      if (connection === 'open') {
        const phone = sock.user?.id?.split(':')[0];
        sessions.set(instance_id, { sock, status: 'connected', phone });
      }
    });

    // Wait for QR
    await new Promise(r => setTimeout(r, 3000));
    const session = sessions.get(instance_id);
    
    res.json({ 
      qr_code: session?.qr, 
      status: session?.status || 'pending' 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/status', (req, res) => {
  const { instance_id } = req.body;
  const session = sessions.get(instance_id);
  
  res.json({ 
    status: session?.status || 'disconnected',
    phone_number: session?.phone 
  });
});

app.post('/api/send-message', async (req, res) => {
  const { instance_id, phone, message } = req.body;
  const session = sessions.get(instance_id);
  
  if (!session?.sock) {
    return res.status(400).json({ error: 'Not connected' });
  }
  
  try {
    const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
