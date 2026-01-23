const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

// Log library version at boot to confirm the deployed build uses the patched whatsapp-web.js
try {
  // For git dependencies, version may still be a semver string, but this confirms what got installed.
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const wwebPkg = require('whatsapp-web.js/package.json');
  console.log(`[Boot] whatsapp-web.js version: ${wwebPkg.version}`);
} catch (e) {
  console.log('[Boot] Could not read whatsapp-web.js package.json');
}

const app = express();
app.use(cors());
app.use(express.json());

// Store active sessions: { [connection_id]: { client, qr, status, phone, webhookUrl } }
const sessions = {};

// Helper pentru delay-uri umane (simulează comportament real, reduce riscul de ban)
function humanDelay(min = 500, max = 1500) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// Helper to get or create a session
function getSession(connection_id) {
  if (!sessions[connection_id]) {
    sessions[connection_id] = {
      client: null,
      qr: null,
      status: 'disconnected',
      phone: null,
      webhookUrl: null,
      lastActivity: Date.now()
    };
  }
  sessions[connection_id].lastActivity = Date.now();
  return sessions[connection_id];
}

// Callback URL for notifying Lovable backend of status changes
const CALLBACK_URL = process.env.CALLBACK_URL || '';

// Patch WhatsApp Web runtime to avoid occasional breaking changes in internal functions.
// In particular, some WA Web updates have caused whatsapp-web.js to throw inside WWebJS.sendSeen
// (e.g. reading `markedUnread` from undefined). We no-op sendSeen to keep sending messages stable.
async function applyRuntimePatches(client, connId) {
  try {
    // whatsapp-web.js exposes the underlying puppeteer page as `pupPage`
    const page = client?.pupPage;
    if (!page) {
      console.log(`[${connId}] Runtime patch skipped: pupPage not available yet`);
      return;
    }

    await page.evaluate(() => {
      // eslint-disable-next-line no-undef
      const w = window;
      if (!w || !w.WWebJS) return;
      if (w.WWebJS.__lovablePatchedSendSeen) return;

      // Replace sendSeen with a safe no-op to avoid WA internal API mismatches.
      // Some library flows call sendSeen implicitly during sendMessage.
      w.WWebJS.sendSeen = async () => true;
      w.WWebJS.__lovablePatchedSendSeen = true;
    });

    console.log(`[${connId}] Runtime patch applied: WWebJS.sendSeen overridden`);
  } catch (e) {
    console.log(`[${connId}] Runtime patch failed (non-fatal): ${e?.message || e}`);
  }
}

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
  
  // Store webhook URL for later use (auto-restore)
  if (webhookUrl) {
    session.webhookUrl = webhookUrl;
  }
  
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
      headless: "new",  // Noul mod headless, mai stabil și mai greu de detectat
      protocolTimeout: 120000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        // Anti-detecție
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-extensions',
        // Performanță
        '--single-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
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

    // Apply runtime patches as soon as the page is ready.
    await applyRuntimePatches(client, connection_id);
    
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
    session.client = null;
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

  // NEW: Listen for state changes to detect session invalidation
  client.on('change_state', (state) => {
    console.log(`[${connection_id}] State changed to: ${state}`);
    if (state === 'CONFLICT' || state === 'UNLAUNCHED' || state === 'UNPAIRED') {
      console.log(`[${connection_id}] Session invalidated, marking as disconnected`);
      session.status = 'disconnected';
      session.qr = null;
      session.phone = null;
      sendStatusCallback(connection_id, 'disconnected');
    }
  });

  // Handle incoming messages -> forward to webhook
  client.on('message', async (message) => {
    console.log(`[${connection_id}] Message from ${message.from}: ${message.body?.substring(0, 50)}...`);
    
    const webhook = session.webhookUrl;
    if (webhook) {
      try {
        await fetch(webhook, {
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
    session.client = null;
    sendStatusCallback(connection_id, 'disconnected');
  });

  session.client = client;
  return session;
}

// NEW: Restore saved sessions on server startup
async function restoreSessions() {
  const authPath = './.wwebjs_auth';
  
  if (!fs.existsSync(authPath)) {
    console.log('[Startup] No saved sessions to restore');
    return;
  }

  try {
    const dirs = fs.readdirSync(authPath);
    const sessionDirs = dirs.filter(dir => dir.startsWith('session-'));
    
    if (sessionDirs.length === 0) {
      console.log('[Startup] No session directories found');
      return;
    }

    console.log(`[Startup] Found ${sessionDirs.length} saved session(s) to restore`);
    
    for (const dir of sessionDirs) {
      const connectionId = dir.replace('session-', '');
      console.log(`[${connectionId}] Attempting to restore saved session...`);
      
      // Initialize client which will use LocalAuth to restore session
      initClient(connectionId, null);
      
      // Delay uman mai mare între inițializări pentru a evita detecția
      await humanDelay(3000, 5000);
    }
  } catch (err) {
    console.error('[Startup] Error restoring sessions:', err);
  }
}

// NEW: Helper function to verify real connection state with timeout
async function verifyConnectionState(session, connId, timeoutMs = 5000) {
  if (!session.client) {
    return { connected: false, reason: 'no_client' };
  }
  
  try {
    // Add timeout to getState() call
    const statePromise = session.client.getState();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('State check timeout')), timeoutMs)
    );
    
    const state = await Promise.race([statePromise, timeoutPromise]);
    console.log(`[${connId}] Real state check: ${state}`);
    
    if (state !== 'CONNECTED') {
      // Update session status to reflect reality
      session.status = 'disconnected';
      sendStatusCallback(connId, 'disconnected');
      return { connected: false, reason: `state_${state}`, state };
    }
    
    return { connected: true, state };
  } catch (err) {
    console.log(`[${connId}] State check failed: ${err.message}`);
    session.status = 'disconnected';
    session.client = null;
    sendStatusCallback(connId, 'disconnected');
    return { connected: false, reason: 'state_check_error', error: err.message };
  }
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
app.post('/api/status', async (req, res) => {
  const { instance_id, connection_id } = req.body;
  const connId = connection_id || instance_id;
  
  if (!connId) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  const session = getSession(connId);
  
  // If session thinks it's connected, verify real state
  if (session.status === 'connected' && session.client) {
    const stateCheck = await verifyConnectionState(session, connId);
    if (!stateCheck.connected) {
      return res.json({
        status: 'disconnected',
        phone_number: null,
        has_qr: false,
        reason: stateCheck.reason
      });
    }
  }
  
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

// NEW: Reconnect endpoint - force reconnection using saved session
app.post('/api/reconnect', async (req, res) => {
  const { instance_id, connection_id, webhook_url } = req.body;
  const connId = connection_id || instance_id;
  
  if (!connId) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  console.log(`[${connId}] Reconnect request`);
  
  const session = getSession(connId);
  
  // Destroy existing client if any
  if (session.client) {
    try {
      await session.client.destroy();
    } catch (e) {
      console.log(`[${connId}] Error destroying old client:`, e.message);
    }
  }
  
  // Reset session state
  session.client = null;
  session.status = 'disconnected';
  session.qr = null;
  
  // Store webhook URL if provided
  if (webhook_url) {
    session.webhookUrl = webhook_url;
  }
  
  // Re-initialize client (will use saved LocalAuth session if available)
  initClient(connId, session.webhookUrl);
  
  res.json({ status: 'reconnecting', message: 'Attempting to reconnect...' });
});

// Send message - with real state verification
app.post('/api/send-message', async (req, res) => {
  const { instance_id, connection_id, to, message, type = 'text' } = req.body;
  const connId = connection_id || instance_id;
  
  if (!connId || !to || !message) {
    return res.status(400).json({ error: 'connection_id, to, and message required' });
  }

  console.log(`[${connId}] Send message to ${to}`);
  
  const session = getSession(connId);
  
  // Basic check
  if (!session.client || session.status !== 'connected') {
    console.log(`[${connId}] Basic check failed: client=${!!session.client}, status=${session.status}`);
    return res.status(400).json({ 
      error: 'Connection not connected',
      status: session.status,
      needs_reconnect: true
    });
  }

  // Quick state verification with short timeout (skip if it takes too long)
  console.log(`[${connId}] Verifying connection state...`);
  const stateCheck = await verifyConnectionState(session, connId, 3000);
  if (!stateCheck.connected) {
    console.log(`[${connId}] State check failed: ${stateCheck.reason}`);
    return res.status(400).json({ 
      error: 'WhatsApp session expired. Please reconnect.',
      status: 'disconnected',
      reason: stateCheck.reason,
      needs_reconnect: true
    });
  }
  console.log(`[${connId}] State OK, sending message...`);

  try {
    // Ensure runtime patches are applied before sending.
    await applyRuntimePatches(session.client, connId);

    // Format number: ensure @c.us suffix
    let chatId = to;
    if (!chatId.includes('@')) {
      chatId = `${chatId.replace(/[^0-9]/g, '')}@c.us`;
    }

    // Delay uman înainte de trimitere (reduce riscul de ban)
    await humanDelay(300, 800);
    
    // Add timeout to sendMessage to prevent hanging
    const sendPromise = session.client.sendMessage(chatId, message);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Send message timeout after 30s')), 30000)
    );
    
    const result = await Promise.race([sendPromise, timeoutPromise]);
    console.log(`[${connId}] Message sent successfully to ${to}`);
    
    res.json({
      success: true, 
      messageId: result.id?.id,
      timestamp: result.timestamp
    });
  } catch (err) {
    console.error(`[${connId}] Send error:`, err);
    
    // If send fails, check if it's a connection issue
    if (err.message.includes('Protocol error') || err.message.includes('Session closed')) {
      session.status = 'disconnected';
      session.client = null;
      sendStatusCallback(connId, 'disconnected');
      return res.status(400).json({ 
        error: 'Connection lost during send. Please reconnect.',
        needs_reconnect: true
      });
    }
    
    res.status(500).json({ error: err.message });
  }
});

// Keep-alive endpoint - ping to maintain session active
app.post('/api/keep-alive', async (req, res) => {
  const { instance_id, connection_id } = req.body;
  const connId = connection_id || instance_id;
  
  if (!connId) {
    return res.status(400).json({ error: 'connection_id required' });
  }

  const session = getSession(connId);
  
  if (session.client && session.status === 'connected') {
    const stateCheck = await verifyConnectionState(session, connId);
    if (stateCheck.connected) {
      session.lastActivity = Date.now();
      res.json({ status: 'alive', connection_status: 'connected', state: stateCheck.state });
    } else {
      res.json({ status: 'disconnected', reason: stateCheck.reason, needs_reconnect: true });
    }
  } else {
    res.json({ status: 'not_connected', connection_status: session.status });
  }
});

// Internal keep-alive for all connected sessions (every 3 min)
setInterval(async () => {
  const connectedSessions = Object.entries(sessions).filter(([, s]) => s.status === 'connected' && s.client);
  if (connectedSessions.length === 0) return;
  
  console.log(`[Keep-alive] Pinging ${connectedSessions.length} connected session(s)...`);
  
  for (const [id, session] of connectedSessions) {
    try {
      const state = await session.client.getState();
      session.lastActivity = Date.now();
      console.log(`[${id}] Internal keep-alive OK, state: ${state}`);
      
      // If state is not CONNECTED, mark session as disconnected
      if (state !== 'CONNECTED') {
        console.log(`[${id}] Session no longer connected (state: ${state}), marking as disconnected`);
        session.status = 'disconnected';
        session.client = null;
        sendStatusCallback(id, 'disconnected');
      }
    } catch (err) {
      console.log(`[${id}] Internal keep-alive failed: ${err.message}, marking as disconnected`);
      session.status = 'disconnected';
      session.client = null;
      sendStatusCallback(id, 'disconnected');
    }
  }
}, 3 * 60 * 1000);

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
  
  // Restore saved sessions after a short delay
  setTimeout(() => {
    restoreSessions();
  }, 3000);
});
