const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// Store active sessions: { [instance_id]: { client, qr, status, phone } }
const sessions = {};

// Helper to get or create a session
function getSession(instance_id) {
  if (!sessions[instance_id]) {
    sessions[instance_id] = {
      client: null,
      qr: null,
      status: 'disconnected',
      phone: null,
      lastActivity: Date.now()
    };
  }
  sessions[instance_id].lastActivity = Date.now();
  return sessions[instance_id];
}

// Initialize WhatsApp client for an instance
function initClient(instance_id, webhookUrl) {
  const session = getSession(instance_id);
  
  // If already connected or connecting, skip
  if (session.client && ['connected', 'connecting', 'qr_pending'].includes(session.status)) {
    console.log(`[${instance_id}] Client already exists with status: ${session.status}`);
    return session;
  }

  console.log(`[${instance_id}] Initializing new WhatsApp client...`);
  
  session.status = 'connecting';
  session.qr = null;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: instance_id }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log(`[${instance_id}] QR code received`);
    try {
      // Convert QR string to base64 PNG image
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      session.qr = qrDataUrl;
      session.status = 'qr_pending';
    } catch (err) {
      console.error(`[${instance_id}] QR generation error:`, err);
    }
  });

  client.on('ready', async () => {
    console.log(`[${instance_id}] WhatsApp client ready!`);
    session.status = 'connected';
    session.qr = null;
    
    try {
      const info = client.info;
      session.phone = info?.wid?.user || null;
      console.log(`[${instance_id}] Connected phone: ${session.phone}`);
    } catch (e) {
      console.error(`[${instance_id}] Error getting phone info:`, e);
    }
  });

  client.on('authenticated', () => {
    console.log(`[${instance_id}] Authenticated`);
    session.status = 'connecting';
    session.qr = null;
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${instance_id}] Auth failure:`, msg);
    session.status = 'disconnected';
    session.qr = null;
  });

  client.on('disconnected', (reason) => {
    console.log(`[${instance_id}] Disconnected:`, reason);
    session.status = 'disconnected';
    session.qr = null;
    session.phone = null;
    session.client = null;
  });

  // Handle incoming messages -> forward to webhook
  client.on('message', async (message) => {
    console.log(`[${instance_id}] Message from ${message.from}: ${message.body?.substring(0, 50)}...`);
    
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instance_id,
            event: 'message',
            data: {
              from: message.from,
              to: message.to,
              body: message.body,
              timestamp: message.timestamp,
              type: message.type,
              hasMedia: message.hasMedia
            }
          })
        });
      } catch (err) {
        console.error(`[${instance_id}] Webhook error:`, err.message);
      }
    }
  });

  client.initialize().catch(err => {
    console.error(`[${instance_id}] Client init error:`, err);
    session.status = 'disconnected';
  });

  session.client = client;
  return session;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: Object.keys(sessions).length });
});

// Get QR code for instance
app.post('/api/get-qr', async (req, res) => {
  const { instance_id, token, webhook_url } = req.body;
  
  if (!instance_id) {
    return res.status(400).json({ error: 'instance_id required' });
  }

  console.log(`[${instance_id}] GET-QR request`);
  
  const session = initClient(instance_id, webhook_url);

  // If already connected
  if (session.status === 'connected') {
    return res.json({ 
      status: 'connected', 
      phone_number: session.phone 
    });
  }

  // If QR is ready
  if (session.qr) {
    return res.json({ 
      qr: session.qr, 
      status: 'qr_pending' 
    });
  }

  // Still initializing/waiting for QR
  return res.json({ status: 'pending' });
});

// Get status
app.post('/api/status', (req, res) => {
  const { instance_id } = req.body;
  
  if (!instance_id) {
    return res.status(400).json({ error: 'instance_id required' });
  }

  const session = getSession(instance_id);
  
  res.json({
    status: session.status,
    phone_number: session.phone,
    has_qr: !!session.qr
  });
});

// Disconnect instance
app.post('/api/disconnect', async (req, res) => {
  const { instance_id } = req.body;
  
  if (!instance_id) {
    return res.status(400).json({ error: 'instance_id required' });
  }

  console.log(`[${instance_id}] Disconnect request`);
  
  const session = getSession(instance_id);
  
  if (session.client) {
    try {
      await session.client.logout();
      await session.client.destroy();
    } catch (e) {
      console.error(`[${instance_id}] Disconnect error:`, e);
    }
  }

  session.client = null;
  session.qr = null;
  session.status = 'disconnected';
  session.phone = null;

  res.json({ status: 'disconnected' });
});

// Send message
app.post('/api/send-message', async (req, res) => {
  const { instance_id, to, message, type = 'text' } = req.body;
  
  if (!instance_id || !to || !message) {
    return res.status(400).json({ error: 'instance_id, to, and message required' });
  }

  console.log(`[${instance_id}] Send message to ${to}`);
  
  const session = getSession(instance_id);
  
  if (!session.client || session.status !== 'connected') {
    return res.status(400).json({ error: 'Instance not connected' });
  }

  try {
    // Format number: ensure @c.us suffix
    let chatId = to;
    if (!chatId.includes('@')) {
      chatId = `${chatId.replace(/[^0-9]/g, '')}@c.us`;
    }

    const result = await session.client.sendMessage(chatId, message);
    
    res.json({ 
      success: true, 
      messageId: result.id?.id,
      timestamp: result.timestamp
    });
  } catch (err) {
    console.error(`[${instance_id}] Send error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// Cleanup inactive sessions (optional, runs every 30 min)
setInterval(() => {
  const now = Date.now();
  const maxInactive = 30 * 60 * 1000; // 30 minutes
  
  Object.entries(sessions).forEach(async ([id, session]) => {
    if (session.status === 'disconnected' && (now - session.lastActivity) > maxInactive) {
      console.log(`[${id}] Cleaning up inactive session`);
      if (session.client) {
        try {
          await session.client.destroy();
        } catch (e) {}
      }
      delete sessions[id];
    }
  });
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`WhatsApp Bridge running on port ${PORT}`);
});
