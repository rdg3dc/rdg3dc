const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json());

// Store active sessions: { [connection_id]: { client, qr, status, phone } }
const sessions = {};

// Helper to get or create a session
function getSession(connection_id) {
  if (!sessions[connection_id]) {
    sessions[connection_id] = {
      client: null,
      qr: null,
      status: 'disconnected',
      phone: null,
      lastActivity: Date.now()
    };
  }
  sessions[connection_id].lastActivity = Date.now();
  return sessions[connection_id];
}

// Callback URL for notifying Lovable backend of status changes
const CALLBACK_URL = process.env.CALLBACK_URL || '';

// Send status update to Lovable backend
async function sendStatusCallback(connection_id, status, phone_number = null) {
  if (!CALLBACK_URL) {
    console.log(`[${connection_id}] No CALLBACK_URL configured, skipping status callback`);
    return;
  }
  
  try {
    console.log(`[${connection_id}] Sending status callback: ${status}, phone: ${phone_number}`);
    const response = await fetch(CALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_id,
        instance_id: connection_id, // Keep for backwards compatibility
        status,
        phone_number
      })
    });
    const result = await response.text();
    console.log(`[${connection_id}] Callback response: ${response.status} - ${result}`);
  } catch (err) {
    console.error(`[${connection_id}] Callback error:`, err.message);
  }
}

// Initialize WhatsApp client for a connection
function initClient(connection_id, webhookUrl) {
  const session = getSession(connection_id);
  
  // If already connected or connecting, skip
  if (session.client && ['connected', 'connecting', 'qr_pending'].includes(session.status)) {
    console.log(`[${connection_id}] Client already exists with status: ${session.status}`);
    return session;
  }

  console.log(`[${connection_id}] Initializing new WhatsApp client...`);
  
  session.status = 'connecting';
  session.qr = null;

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: connection_id }),
    puppeteer: {
      headless: true,
      // Fix for ProtocolError: Runtime.callFunctionOn timed out
      protocolTimeout: 120000,
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
    console.log(`[${connection_id}] QR code received`);
    try {
      // Convert QR string to base64 PNG image
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
      session.qr = qrDataUrl;
      session.status = 'qr_pending';
      // Notify backend about QR pending status
      sendStatusCallback(connection_id, 'qr_pending');
    } catch (err) {
      console.error(`[${connection_id}] QR generation error:`, err);
    }
  });

  client.on('ready', async () => {
    console.log(`[${connection_id}] WhatsApp client ready!`);
    session.status = 'connected';
    session.qr = null;
    
    try {
      const info = client.info;
      session.phone = info?.wid?.user || null;
      console.log(`[${connection_id}] Connected phone: ${session.phone}`);
      // IMPORTANT: Send callback to update database
      sendStatusCallback(connection_id, 'connected', session.phone);
    } catch (e) {
      console.error(`[${connection_id}] Error getting phone info:`, e);
      // Still send connected status even if we couldn't get phone
      sendStatusCallback(connection_id, 'connected');
    }
  });

  client.on('authenticated', () => {
    console.log(`[${connection_id}] Authenticated`);
    session.status = 'connecting';
    session.qr = null;
  });

  client.on('auth_failure', (msg) => {
    console.error(`[${connection_id}] Auth failure:`, msg);
    session.status = 'disconnected';
    session.qr = null;
    sendStatusCallback(connection_id, 'disconnected');
  });

  client.on('disconnected', (reason) => {
    console.log(`[${connection_id}] Disconnected:`, reason);
    session.status = 'disconnected';
    session.qr = null;
    session.phone = null;
    session.client = null;
    sendStatusCallback(connection_id, 'disconnected');
  });

  // Handle incoming messages -> forward to webhook
  client.on('message', async (message) => {
    console.log(`[${connection_id}] Message from ${message.from}: ${message.body?.substring(0, 50)}...`);
    
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connection_id,
            instance_id: connection_id, // Keep for backwards compatibility
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
        console.error(`[${connection_id}] Webhook error:`, err.message);
      }
    }
  });

  client.initialize().catch(err => {
    console.error(`[${connection_id}] Client init error:`, err);
    session.status = 'disconnected';
    sendStatusCallback(connection_id, 'disconnected');
  });

  session.client = client;
  return session;
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: Object.keys(sessions).length });
});

// Get QR code for connection
app.post('/api/get-qr', async (req, res) => {
  const { instance_id, connection_id, token, webhook_url } = req.body;
  const connId = connection_id || instance_id; // Support both for backwards compatibility
  
  if (!connId) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  console.log(`[${connId}] GET-QR request`);
  
  const session = initClient(connId, webhook_url);

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
  const { instance_id, connection_id } = req.body;
  const connId = connection_id || instance_id;
  
  if (!connId) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  const session = getSession(connId);
  
  res.json({
    status: session.status,
    phone_number: session.phone,
    has_qr: !!session.qr
  });
});

// Disconnect connection
app.post('/api/disconnect', async (req, res) => {
  const { instance_id, connection_id } = req.body;
  const connId = connection_id || instance_id;
  
  if (!connId) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  console.log(`[${connId}] Disconnect request`);
  
  const session = getSession(connId);
  
  if (session.client) {
    try {
      await session.client.logout();
      await session.client.destroy();
    } catch (e) {
      console.error(`[${connId}] Disconnect error:`, e);
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
  const { instance_id, connection_id, to, message, type = 'text' } = req.body;
  const connId = connection_id || instance_id;
  
  if (!connId || !to || !message) {
    return res.status(400).json({ error: 'connection_id, to, and message required' });
  }

  console.log(`[${connId}] Send message to ${to}`);
  
  const session = getSession(connId);
  
  if (!session.client || session.status !== 'connected') {
    return res.status(400).json({ error: 'Connection not connected' });
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
    console.error(`[${connId}] Send error:`, err);
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
