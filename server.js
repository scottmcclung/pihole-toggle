const http = require('http');
const https = require('https');

const PIHOLE_URL = process.env.PIHOLE_URL || 'http://localhost';
const PIHOLE_PASSWORD = process.env.PIHOLE_PASSWORD || '';
const PORT = process.env.PORT || 3000;

// Session cache
let cachedSession = null;
let sessionExpiresAt = 0;

/**
 * Make an HTTP request and return parsed JSON response
 */
function request(url, options, body = null, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      return reject(new Error('Too many redirects'));
    }

    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = transport.request(reqOptions, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        return resolve(request(redirectUrl, options, body, redirectCount + 1));
      }

      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Authenticate with Pi-hole and get session credentials
 * Caches session to avoid exceeding API seat limits
 */
async function authenticate() {
  // Return cached session if still valid (with 30s buffer)
  if (cachedSession && Date.now() < sessionExpiresAt - 30000) {
    return cachedSession;
  }

  const url = `${PIHOLE_URL}/api/auth`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ password: PIHOLE_PASSWORD }));

  if (res.status !== 200 || !res.data?.session?.valid) {
    console.error('Auth failed:', { status: res.status, response: res.data });
    cachedSession = null;
    sessionExpiresAt = 0;
    throw new Error(`Authentication failed: ${JSON.stringify(res.data)}`);
  }

  // Cache the session (validity is in seconds)
  const validityMs = (res.data.session.validity || 300) * 1000;
  cachedSession = {
    sid: res.data.session.sid,
    csrf: res.data.session.csrf,
  };
  sessionExpiresAt = Date.now() + validityMs;

  return cachedSession;
}

/**
 * Get current blocking status from Pi-hole
 */
async function getStatus(retry = true) {
  const { sid } = await authenticate();
  const res = await request(`${PIHOLE_URL}/api/dns/blocking`, {
    method: 'GET',
    headers: { 'X-FTL-SID': sid },
  });

  // If session expired, clear cache and retry once
  if (res.status === 401 && retry) {
    cachedSession = null;
    sessionExpiresAt = 0;
    return getStatus(false);
  }

  return res.data;
}

/**
 * Set blocking state on Pi-hole
 */
async function setBlocking(enabled, timerSeconds = null, retry = true) {
  const { sid, csrf } = await authenticate();

  const url = `${PIHOLE_URL}/api/dns/blocking`;
  const body = { blocking: enabled };
  if (!enabled && timerSeconds) {
    body.timer = timerSeconds;
  }

  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-FTL-SID': sid,
      'X-FTL-CSRF': csrf,
    },
  }, JSON.stringify(body));

  // If session expired, clear cache and retry once
  if (res.status === 401 && retry) {
    cachedSession = null;
    sessionExpiresAt = 0;
    return setBlocking(enabled, timerSeconds, false);
  }

  if (res.status !== 200) {
    throw new Error(`Failed to set blocking: ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

/**
 * Send JSON response
 */
function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send redirect response
 */
function redirect(res, location) {
  res.writeHead(302, { 'Location': location });
  res.end();
}

/**
 * Generate the HTML status page
 */
function getStatusPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi-hole Toggle</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .container {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border-radius: 24px;
      padding: 40px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .logo {
      font-size: 48px;
      margin-bottom: 20px;
    }

    h1 {
      color: #fff;
      font-size: 24px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .subtitle {
      color: rgba(255, 255, 255, 0.6);
      font-size: 14px;
      margin-bottom: 32px;
    }

    .status-card {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .status-label {
      color: rgba(255, 255, 255, 0.6);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
    }

    .status-value {
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .status-enabled {
      color: #4ade80;
    }

    .status-disabled {
      color: #f87171;
    }

    .status-loading {
      color: #fbbf24;
    }

    .timer {
      color: rgba(255, 255, 255, 0.8);
      font-size: 16px;
      font-variant-numeric: tabular-nums;
      margin-top: 8px;
    }

    .timer-label {
      color: rgba(255, 255, 255, 0.5);
      font-size: 12px;
    }

    .toggle-btn {
      width: 100%;
      padding: 16px 32px;
      font-size: 16px;
      font-weight: 600;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .toggle-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .toggle-btn.enable {
      background: linear-gradient(135deg, #4ade80 0%, #22c55e 100%);
      color: #000;
    }

    .toggle-btn.enable:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(74, 222, 128, 0.3);
    }

    .toggle-btn.disable {
      background: linear-gradient(135deg, #f87171 0%, #ef4444 100%);
      color: #fff;
    }

    .toggle-btn.disable:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 0 10px 30px rgba(248, 113, 113, 0.3);
    }

    .duration-label {
      color: rgba(255, 255, 255, 0.6);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 20px;
      margin-bottom: 12px;
    }

    .duration-picker {
      display: flex;
      margin-top: 0;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .duration-picker.show {
      display: flex;
    }

    .duration-btn {
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .duration-btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.3);
    }

    .error {
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 12px;
      border-radius: 8px;
      margin-top: 16px;
      font-size: 14px;
    }

    .last-updated {
      color: rgba(255, 255, 255, 0.4);
      font-size: 11px;
      margin-top: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🛡️</div>
    <h1>Pi-hole Toggle</h1>
    <p class="subtitle">Ad blocking control</p>

    <div class="status-card">
      <div class="status-label">Blocking Status</div>
      <div id="status" class="status-value status-loading">Loading...</div>
      <div id="timer" class="timer"></div>
    </div>

    <button id="enableBtn" class="toggle-btn enable" style="display: none;">Enable Blocking</button>

    <div class="duration-label" id="durationLabel">Disable for:</div>
    <div id="durationPicker" class="duration-picker show">
      <button class="duration-btn" data-minutes="30">30 min</button>
      <button class="duration-btn" data-minutes="60">1 hr</button>
      <button class="duration-btn" data-minutes="120">2 hrs</button>
      <button class="duration-btn" data-minutes="240">4 hrs</button>
      <button class="duration-btn" data-minutes="480">8 hrs</button>
      <button class="duration-btn" data-minutes="720">12 hrs</button>
      <button class="duration-btn" data-minutes="1440">24 hrs</button>
    </div>

    <div id="error" class="error" style="display: none;"></div>

    <div class="last-updated">Last updated: <span id="lastUpdated">-</span></div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const timerEl = document.getElementById('timer');
    const enableBtn = document.getElementById('enableBtn');
    const durationLabel = document.getElementById('durationLabel');
    const durationPicker = document.getElementById('durationPicker');
    const errorEl = document.getElementById('error');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    let currentState = null;
    let currentTimer = 0;
    let timerEndTime = null;
    let timerInterval = null;

    function formatTime(seconds) {
      const hrs = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      if (hrs > 0) {
        return hrs + ':' + mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
      }
      return mins + ':' + secs.toString().padStart(2, '0');
    }

    function updateTimerDisplay() {
      if (!timerEndTime) {
        timerEl.innerHTML = '';
        return;
      }

      const remaining = Math.max(0, Math.floor((timerEndTime - Date.now()) / 1000));
      if (remaining <= 0) {
        timerEl.innerHTML = '';
        timerEndTime = null;
        fetchStatus();
        return;
      }

      timerEl.innerHTML = '<span class="timer-label">Re-enables in</span><br>' + formatTime(remaining);
    }

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      setTimeout(() => { errorEl.style.display = 'none'; }, 5000);
    }

    function updateUI(data) {
      currentState = data.blocking;
      currentTimer = data.timer || 0;

      statusEl.textContent = data.blocking ? 'Enabled' : 'Disabled';
      statusEl.className = 'status-value ' + (data.blocking ? 'status-enabled' : 'status-disabled');

      if (data.blocking) {
        // Blocking is ON - show duration buttons to disable
        enableBtn.style.display = 'none';
        durationLabel.textContent = 'Disable for:';
        timerEndTime = null;
      } else {
        // Blocking is OFF - show enable button and option to add time
        enableBtn.style.display = 'block';
        durationLabel.textContent = 'Add time:';

        if (data.timer && data.timer > 0) {
          timerEndTime = Date.now() + (data.timer * 1000);
        } else {
          timerEndTime = null;
        }
      }

      enableBtn.disabled = false;
      lastUpdatedEl.textContent = new Date().toLocaleTimeString();
      updateTimerDisplay();
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.success) {
          updateUI(data);
        } else {
          showError(data.error || 'Failed to fetch status');
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
      }
    }

    async function enableBlocking() {
      enableBtn.disabled = true;
      enableBtn.textContent = 'Enabling...';
      try {
        const res = await fetch('/api/enable', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          updateUI(data);
        } else {
          showError(data.error || 'Failed to enable');
          fetchStatus();
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
        fetchStatus();
      }
      enableBtn.textContent = 'Enable Blocking';
    }

    async function disableBlocking(minutes, addTime = false) {
      // Disable all duration buttons while processing
      durationPicker.querySelectorAll('.duration-btn').forEach(b => b.disabled = true);

      try {
        let totalMinutes = minutes;
        if (addTime && currentTimer > 0) {
          // Add to existing timer
          totalMinutes = Math.ceil(currentTimer / 60) + minutes;
        }

        const res = await fetch('/api/disable/' + totalMinutes, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          updateUI(data);
        } else {
          showError(data.error || 'Failed to disable');
          fetchStatus();
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
        fetchStatus();
      }

      // Re-enable duration buttons
      durationPicker.querySelectorAll('.duration-btn').forEach(b => b.disabled = false);
    }

    enableBtn.addEventListener('click', () => {
      enableBlocking();
    });

    durationPicker.querySelectorAll('.duration-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const minutes = parseInt(btn.dataset.minutes);
        if (currentState) {
          // Blocking is enabled - disable for this duration
          disableBlocking(minutes, false);
        } else {
          // Blocking is disabled - add time to timer
          disableBlocking(minutes, true);
        }
      });
    });

    // Initial fetch
    fetchStatus();

    // Poll every 5 seconds
    setInterval(fetchStatus, 5000);

    // Update timer every second
    timerInterval = setInterval(updateTimerDisplay, 1000);
  </script>
</body>
</html>`;
}

/**
 * Handle incoming requests
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // GET / - Status page
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getStatusPage());
    return;
  }

  // GET /enable - Enable blocking and redirect to status page
  if (req.method === 'GET' && path === '/enable') {
    try {
      await setBlocking(true);
    } catch (err) {
      console.error('Enable failed:', err.message);
    }
    redirect(res, '/');
    return;
  }

  // GET /disable/:minutes - Disable blocking and redirect to status page
  const disableMatch = path.match(/^\/disable\/(\d+)$/);
  if (req.method === 'GET' && disableMatch) {
    const minutes = parseInt(disableMatch[1], 10);
    const seconds = minutes * 60;
    try {
      await setBlocking(false, seconds);
    } catch (err) {
      console.error('Disable failed:', err.message);
    }
    redirect(res, '/');
    return;
  }

  // API endpoints for AJAX calls

  // GET /api/status - Get current status as JSON
  if (req.method === 'GET' && path === '/api/status') {
    try {
      const data = await getStatus();
      const isBlocking = data.blocking === 'enabled';
      jsonResponse(res, 200, { success: true, blocking: isBlocking, timer: data.timer || 0 });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // POST /api/enable - Enable blocking
  if (req.method === 'POST' && path === '/api/enable') {
    try {
      const result = await setBlocking(true);
      const isBlocking = result.blocking === 'enabled';
      jsonResponse(res, 200, { success: true, blocking: isBlocking, timer: 0 });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // POST /api/disable/:minutes - Disable blocking
  const apiDisableMatch = path.match(/^\/api\/disable\/(\d+)$/);
  if (req.method === 'POST' && apiDisableMatch) {
    const minutes = parseInt(apiDisableMatch[1], 10);
    const seconds = minutes * 60;
    try {
      const result = await setBlocking(false, seconds);
      const isBlocking = result.blocking === 'enabled';
      jsonResponse(res, 200, { success: true, blocking: isBlocking, timer: result.timer || seconds });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // 404 for everything else
  jsonResponse(res, 404, { error: 'Not found' });
}

// Start server
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`pihole-toggle running on port ${PORT}`);
  console.log(`Pi-hole URL: ${PIHOLE_URL}`);
});
