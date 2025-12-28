const http = require('http');
const https = require('https');

// Configuration
const PORT = process.env.PORT || 3000;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;
const SESSION_BUFFER_MS = 30000;
const MAX_DISABLE_MINUTES = 43200; // 30 days

// Parse Pi-hole instances from environment
function getInstances() {
  // Try new multi-instance format first
  if (process.env.PIHOLE_INSTANCES) {
    try {
      return JSON.parse(process.env.PIHOLE_INSTANCES);
    } catch (e) {
      console.error('Failed to parse PIHOLE_INSTANCES:', e.message);
      process.exit(1);
    }
  }

  // Fall back to single instance format for backwards compatibility
  if (process.env.PIHOLE_URL) {
    return [{
      name: process.env.PIHOLE_NAME || 'Pi-hole',
      url: process.env.PIHOLE_URL,
      password: process.env.PIHOLE_PASSWORD || '',
    }];
  }

  console.error('No Pi-hole instances configured. Set PIHOLE_INSTANCES in .env');
  console.error('Example: PIHOLE_INSTANCES=\'[{"name":"Pi-hole","url":"https://pihole.local","password":"your-password"}]\'');
  process.exit(1);
}

const INSTANCES = getInstances();

// Session cache per instance (keyed by URL)
const sessionCache = new Map();

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/**
 * Make an HTTP request and return parsed JSON response
 */
function request(url, options, body = null, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
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
      // Allow self-signed certificates (common in home labs)
      rejectUnauthorized: false,
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

    // Add timeout to prevent hung connections
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Request timeout'));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Authenticate with a Pi-hole instance and get session credentials
 */
async function authenticate(instance) {
  const cacheKey = instance.url;
  const cached = sessionCache.get(cacheKey);

  // Return cached session if still valid (with buffer)
  if (cached && Date.now() < cached.expiresAt - SESSION_BUFFER_MS) {
    return cached.session;
  }

  const url = `${instance.url}/api/auth`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({ password: instance.password }));

  if (res.status !== 200 || !res.data?.session?.valid) {
    console.error(`Auth failed for ${instance.name}:`, { status: res.status, response: res.data });
    sessionCache.delete(cacheKey);
    throw new Error(`Authentication failed for ${instance.name}`);
  }

  // Cache the session
  const validityMs = (res.data.session.validity || 300) * 1000;
  const session = {
    sid: res.data.session.sid,
    csrf: res.data.session.csrf,
  };
  sessionCache.set(cacheKey, {
    session,
    expiresAt: Date.now() + validityMs,
  });

  return session;
}

/**
 * Get current blocking status and stats from a Pi-hole instance
 */
async function getInstanceStatus(instance, retry = true) {
  try {
    const { sid } = await authenticate(instance);

    // Fetch blocking status and stats in parallel
    const [blockingRes, statsRes] = await Promise.all([
      request(`${instance.url}/api/dns/blocking`, {
        method: 'GET',
        headers: { 'X-FTL-SID': sid },
      }),
      request(`${instance.url}/api/stats/summary`, {
        method: 'GET',
        headers: { 'X-FTL-SID': sid },
      }),
    ]);

    // If session expired, clear cache and retry once
    if ((blockingRes.status === 401 || statsRes.status === 401) && retry) {
      sessionCache.delete(instance.url);
      return getInstanceStatus(instance, false);
    }

    const stats = statsRes.data?.queries || {};

    return {
      name: instance.name,
      url: instance.url,
      blocking: blockingRes.data.blocking === 'enabled',
      timer: blockingRes.data.timer || 0,
      totalQueries: stats.total || 0,
      blockedQueries: stats.blocked || 0,
      percentBlocked: stats.percent_blocked || 0,
      error: null,
    };
  } catch (err) {
    return {
      name: instance.name,
      url: instance.url,
      blocking: null,
      timer: 0,
      totalQueries: 0,
      blockedQueries: 0,
      percentBlocked: 0,
      error: err.message,
    };
  }
}

/**
 * Get status from all Pi-hole instances
 */
async function getAllStatus() {
  const results = await Promise.all(INSTANCES.map(inst => getInstanceStatus(inst)));
  return results;
}

/**
 * Set blocking state on a single Pi-hole instance
 */
async function setInstanceBlocking(instance, enabled, timerSeconds = null, retry = true) {
  const { sid, csrf } = await authenticate(instance);

  const url = `${instance.url}/api/dns/blocking`;
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
    sessionCache.delete(instance.url);
    return setInstanceBlocking(instance, enabled, timerSeconds, false);
  }

  if (res.status !== 200) {
    throw new Error(`Failed to set blocking on ${instance.name}: ${JSON.stringify(res.data)}`);
  }

  return {
    name: instance.name,
    blocking: res.data.blocking === 'enabled',
    timer: res.data.timer || 0,
  };
}

/**
 * Set blocking state on all Pi-hole instances
 */
async function setAllBlocking(enabled, timerSeconds = null) {
  const results = await Promise.allSettled(
    INSTANCES.map(inst => setInstanceBlocking(inst, enabled, timerSeconds))
  );

  return results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return { ...result.value, error: null };
    } else {
      return {
        name: INSTANCES[i].name,
        blocking: null,
        timer: 0,
        error: result.reason.message,
      };
    }
  });
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
      max-width: 500px;
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
      margin-bottom: 24px;
    }

    .instances {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }

    .instance-card {
      background: rgba(0, 0, 0, 0.2);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }

    .instance-info {
      text-align: left;
      flex: 1;
      min-width: 0;
    }

    .instance-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }

    .instance-name {
      color: #fff;
      font-size: 14px;
      font-weight: 600;
    }

    .instance-status {
      font-size: 11px;
      font-weight: 500;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.2);
    }

    .instance-timer {
      color: rgba(255, 255, 255, 0.6);
      font-size: 11px;
      margin-top: 4px;
      font-variant-numeric: tabular-nums;
    }

    .instance-metrics {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .metric {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.7);
    }

    .metric-icon {
      font-size: 12px;
      opacity: 0.8;
    }

    .metric-value {
      font-weight: 600;
      color: rgba(255, 255, 255, 0.9);
      font-variant-numeric: tabular-nums;
    }

    .status-enabled {
      color: #4ade80;
    }

    .status-disabled {
      color: #f87171;
    }

    .status-error {
      color: #fbbf24;
    }

    .status-loading {
      color: rgba(255, 255, 255, 0.5);
    }

    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .indicator-enabled {
      background: #4ade80;
      box-shadow: 0 0 8px rgba(74, 222, 128, 0.5);
    }

    .indicator-disabled {
      background: #f87171;
      box-shadow: 0 0 8px rgba(248, 113, 113, 0.5);
    }

    .indicator-error {
      background: #fbbf24;
      box-shadow: 0 0 8px rgba(251, 191, 36, 0.5);
    }

    .indicator-loading {
      background: rgba(255, 255, 255, 0.3);
    }

    .indicator-loading.pulse {
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.3; transform: scale(1); }
      50% { opacity: 0.8; transform: scale(1.1); }
    }

    .skeleton {
      color: rgba(255, 255, 255, 0.3);
    }

    .instance-card.loading {
      opacity: 0.7;
    }

    .controls {
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      padding-top: 24px;
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
      margin-bottom: 16px;
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

    .duration-label {
      color: rgba(255, 255, 255, 0.6);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
    }

    .duration-picker {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
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

    .duration-btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.3);
    }

    .duration-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
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

    <div id="instances" class="instances"></div>

    <div class="controls">
      <button id="enableBtn" class="toggle-btn enable" style="display: none;">Enable All</button>

      <div class="duration-label" id="durationLabel">Disable all for:</div>
      <div id="durationPicker" class="duration-picker">
        <button class="duration-btn" data-minutes="30">30 min</button>
        <button class="duration-btn" data-minutes="60">1 hr</button>
        <button class="duration-btn" data-minutes="120">2 hrs</button>
        <button class="duration-btn" data-minutes="240">4 hrs</button>
        <button class="duration-btn" data-minutes="480">8 hrs</button>
        <button class="duration-btn" data-minutes="720">12 hrs</button>
        <button class="duration-btn" data-minutes="1440">24 hrs</button>
      </div>
    </div>

    <div id="error" class="error" style="display: none;"></div>

    <div class="last-updated">Last updated: <span id="lastUpdated">-</span></div>
  </div>

  <script>
    const instancesEl = document.getElementById('instances');
    const enableBtn = document.getElementById('enableBtn');
    const durationLabel = document.getElementById('durationLabel');
    const durationPicker = document.getElementById('durationPicker');
    const errorEl = document.getElementById('error');
    const lastUpdatedEl = document.getElementById('lastUpdated');

    // Injected from server - instance names for loading placeholders
    const instanceNames = ${JSON.stringify(INSTANCES.map(i => i.name))};

    let instancesData = [];
    let timerIntervals = new Map();
    let initialLoad = true;

    // Render loading placeholders immediately
    function renderLoadingState() {
      instancesEl.innerHTML = instanceNames.map(name =>
        '<div class="instance-card loading">' +
          '<div class="instance-info">' +
            '<div class="instance-header">' +
              '<div class="instance-name">' + escapeHtml(name) + '</div>' +
              '<div class="instance-status status-loading">Connecting...</div>' +
            '</div>' +
            '<div class="instance-metrics">' +
              '<div class="metric"><span class="metric-icon">📊</span><span class="metric-value skeleton">---</span></div>' +
              '<div class="metric"><span class="metric-icon">🛡</span><span class="metric-value skeleton">---</span></div>' +
              '<div class="metric"><span class="metric-icon">%</span><span class="metric-value skeleton">--</span></div>' +
            '</div>' +
          '</div>' +
          '<div class="status-indicator indicator-loading pulse"></div>' +
        '</div>'
      ).join('');
    }

    function formatTime(seconds) {
      const hrs = Math.floor(seconds / 3600);
      const mins = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      if (hrs > 0) {
        return hrs + ':' + mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
      }
      return mins + ':' + secs.toString().padStart(2, '0');
    }

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      setTimeout(() => { errorEl.style.display = 'none'; }, 5000);
    }

    function formatNumber(num) {
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return num.toString();
    }

    function escapeHtml(str) {
      if (typeof str !== 'string') return str;
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function renderInstances() {
      instancesEl.innerHTML = instancesData.map((inst, i) => {
        let statusClass, indicatorClass, statusText, timerHtml = '';

        if (inst.error) {
          statusClass = 'status-error';
          indicatorClass = 'indicator-error';
          statusText = 'Error';
        } else if (inst.blocking === null) {
          statusClass = 'status-loading';
          indicatorClass = 'indicator-loading';
          statusText = 'Loading...';
        } else if (inst.blocking) {
          statusClass = 'status-enabled';
          indicatorClass = 'indicator-enabled';
          statusText = 'Enabled';
        } else {
          statusClass = 'status-disabled';
          indicatorClass = 'indicator-disabled';
          statusText = 'Disabled';
          if (inst.timerEnd && inst.timerEnd > Date.now()) {
            const remaining = Math.floor((inst.timerEnd - Date.now()) / 1000);
            timerHtml = '<div class="instance-timer">⏱ Re-enables in ' + formatTime(remaining) + '</div>';
          }
        }

        const metricsHtml = !inst.error ?
          '<div class="instance-metrics">' +
            '<div class="metric"><span class="metric-icon">📊</span><span class="metric-value">' + formatNumber(inst.totalQueries || 0) + '</span></div>' +
            '<div class="metric"><span class="metric-icon">🛡</span><span class="metric-value">' + formatNumber(inst.blockedQueries || 0) + '</span></div>' +
            '<div class="metric"><span class="metric-icon">%</span><span class="metric-value">' + (inst.percentBlocked || 0).toFixed(1) + '</span></div>' +
          '</div>' : '';

        return '<div class="instance-card">' +
          '<div class="instance-info">' +
            '<div class="instance-header">' +
              '<div class="instance-name">' + escapeHtml(inst.name) + '</div>' +
              '<div class="instance-status ' + statusClass + '">' + statusText + '</div>' +
            '</div>' +
            metricsHtml +
            timerHtml +
          '</div>' +
          '<div class="status-indicator ' + indicatorClass + '"></div>' +
        '</div>';
      }).join('');
    }

    function updateControls() {
      const anyDisabled = instancesData.some(i => i.blocking === false);
      const allDisabled = instancesData.every(i => i.blocking === false);

      // Show enable button if any instance is disabled
      if (anyDisabled) {
        enableBtn.style.display = 'block';
      } else {
        enableBtn.style.display = 'none';
      }

      // Change label based on state
      if (allDisabled) {
        durationLabel.textContent = 'Add time to all:';
      } else {
        durationLabel.textContent = 'Disable all for:';
      }
    }

    function updateTimers() {
      let needsRender = false;
      instancesData.forEach(inst => {
        if (inst.timerEnd && inst.timerEnd <= Date.now()) {
          inst.timerEnd = null;
          needsRender = true;
        }
      });
      if (needsRender) {
        fetchStatus();
      } else {
        renderInstances();
      }
    }

    function updateUI(data) {
      instancesData = data.map(inst => ({
        ...inst,
        timerEnd: inst.timer > 0 ? Date.now() + (inst.timer * 1000) : null,
        totalQueries: inst.totalQueries || 0,
        blockedQueries: inst.blockedQueries || 0,
        percentBlocked: inst.percentBlocked || 0,
      }));

      renderInstances();
      updateControls();
      lastUpdatedEl.textContent = new Date().toLocaleTimeString();
    }

    async function fetchStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.success) {
          updateUI(data.instances);
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
      durationPicker.querySelectorAll('.duration-btn').forEach(b => b.disabled = true);

      try {
        const res = await fetch('/api/enable', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          updateUI(data.instances);
        } else {
          showError(data.error || 'Failed to enable');
          fetchStatus();
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
        fetchStatus();
      }

      enableBtn.textContent = 'Enable All';
      enableBtn.disabled = false;
      durationPicker.querySelectorAll('.duration-btn').forEach(b => b.disabled = false);
    }

    async function disableBlocking(minutes, addTime = false) {
      enableBtn.disabled = true;
      durationPicker.querySelectorAll('.duration-btn').forEach(b => b.disabled = true);

      try {
        let totalMinutes = minutes;
        if (addTime) {
          // Add to the maximum existing timer across all instances
          const maxTimer = Math.max(...instancesData.map(i => i.timer || 0));
          if (maxTimer > 0) {
            totalMinutes = Math.ceil(maxTimer / 60) + minutes;
          }
        }

        const res = await fetch('/api/disable/' + totalMinutes, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          updateUI(data.instances);
        } else {
          showError(data.error || 'Failed to disable');
          fetchStatus();
        }
      } catch (err) {
        showError('Connection error: ' + err.message);
        fetchStatus();
      }

      enableBtn.disabled = false;
      durationPicker.querySelectorAll('.duration-btn').forEach(b => b.disabled = false);
    }

    enableBtn.addEventListener('click', () => {
      enableBlocking();
    });

    durationPicker.querySelectorAll('.duration-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const minutes = parseInt(btn.dataset.minutes);
        const allDisabled = instancesData.every(i => i.blocking === false);
        disableBlocking(minutes, allDisabled);
      });
    });

    // Show loading placeholders immediately
    renderLoadingState();

    // Initial fetch
    fetchStatus();

    // Poll every 5 seconds
    setInterval(fetchStatus, 5000);

    // Update timer displays every second
    setInterval(updateTimers, 1000);
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
    res.writeHead(200, {
      'Content-Type': 'text/html',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
    });
    res.end(getStatusPage());
    return;
  }

  // GET /enable - Enable blocking on all instances and redirect
  if (req.method === 'GET' && path === '/enable') {
    try {
      await setAllBlocking(true);
    } catch (err) {
      console.error('Enable failed:', err.message);
    }
    redirect(res, '/');
    return;
  }

  // GET /disable/:minutes - Disable blocking on all instances and redirect
  const disableMatch = path.match(/^\/disable\/(\d+)$/);
  if (req.method === 'GET' && disableMatch) {
    const minutes = parseInt(disableMatch[1], 10);
    if (minutes < 1 || minutes > MAX_DISABLE_MINUTES) {
      redirect(res, '/?error=invalid_duration');
      return;
    }
    const seconds = minutes * 60;
    try {
      await setAllBlocking(false, seconds);
    } catch (err) {
      console.error('Disable failed:', err.message);
    }
    redirect(res, '/');
    return;
  }

  // API endpoints

  // GET /api/status - Get status from all instances
  if (req.method === 'GET' && path === '/api/status') {
    try {
      const instances = await getAllStatus();
      jsonResponse(res, 200, { success: true, instances });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // POST /api/enable - Enable blocking on all instances
  if (req.method === 'POST' && path === '/api/enable') {
    try {
      const instances = await setAllBlocking(true);
      jsonResponse(res, 200, { success: true, instances });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // POST /api/disable/:minutes - Disable blocking on all instances
  const apiDisableMatch = path.match(/^\/api\/disable\/(\d+)$/);
  if (req.method === 'POST' && apiDisableMatch) {
    const minutes = parseInt(apiDisableMatch[1], 10);
    if (minutes < 1 || minutes > MAX_DISABLE_MINUTES) {
      jsonResponse(res, 400, { success: false, error: `Duration must be between 1 and ${MAX_DISABLE_MINUTES} minutes` });
      return;
    }
    const seconds = minutes * 60;
    try {
      const instances = await setAllBlocking(false, seconds);
      jsonResponse(res, 200, { success: true, instances });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
    return;
  }

  // GET /health - Health check endpoint
  if (req.method === 'GET' && path === '/health') {
    jsonResponse(res, 200, { status: 'ok', instances: INSTANCES.length });
    return;
  }

  // 404 for everything else
  jsonResponse(res, 404, { error: 'Not found' });
}

// Start server
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log(`pihole-toggle running on port ${PORT}`);
  console.log(`Managing ${INSTANCES.length} Pi-hole instance(s):`);
  INSTANCES.forEach(inst => console.log(`  - ${inst.name}: ${inst.url}`));
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  // Force exit after 5 seconds
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
