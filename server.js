const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

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

// Load HTML template once at startup
const HTML_TEMPLATE_PATH = path.join(__dirname, 'index.html');
const HTML_TEMPLATE = fs.readFileSync(HTML_TEMPLATE_PATH, 'utf8');

// =============================================================================
// HTTP Utilities
// =============================================================================

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
 * Send HTML response
 */
function htmlResponse(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline' https://unpkg.com; style-src 'unsafe-inline'"
  });
  res.end(html);
}

// =============================================================================
// Pi-hole API
// =============================================================================

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
    console.error(`[${instance.name}] Connection error:`, err.message);
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

// =============================================================================
// HTML Template
// =============================================================================

/**
 * Get the status page HTML with instance names injected
 */
function getStatusPage() {
  const instanceNames = JSON.stringify(INSTANCES.map(i => i.name));
  return HTML_TEMPLATE.replace('/*__INSTANCE_NAMES__*/[]', instanceNames);
}

// =============================================================================
// Route Handlers
// =============================================================================

const routes = {
  'GET /': async (req, res) => {
    htmlResponse(res, getStatusPage());
  },

  'GET /enable': async (req, res) => {
    try {
      await setAllBlocking(true);
    } catch (err) {
      console.error('Enable failed:', err.message);
    }
    redirect(res, '/');
  },

  'GET /disable/:minutes': async (req, res, params) => {
    const minutes = parseInt(params.minutes, 10);
    if (minutes < 1 || minutes > MAX_DISABLE_MINUTES) {
      redirect(res, '/?error=invalid_duration');
      return;
    }
    try {
      await setAllBlocking(false, minutes * 60);
    } catch (err) {
      console.error('Disable failed:', err.message);
    }
    redirect(res, '/');
  },

  'GET /api/status': async (req, res) => {
    try {
      const instances = await getAllStatus();
      jsonResponse(res, 200, { success: true, instances });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
  },

  'POST /api/enable': async (req, res) => {
    try {
      const instances = await setAllBlocking(true);
      jsonResponse(res, 200, { success: true, instances });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
  },

  'POST /api/disable/:minutes': async (req, res, params) => {
    const minutes = parseInt(params.minutes, 10);
    if (minutes < 1 || minutes > MAX_DISABLE_MINUTES) {
      jsonResponse(res, 400, { success: false, error: `Duration must be between 1 and ${MAX_DISABLE_MINUTES} minutes` });
      return;
    }
    try {
      const instances = await setAllBlocking(false, minutes * 60);
      jsonResponse(res, 200, { success: true, instances });
    } catch (err) {
      jsonResponse(res, 500, { success: false, error: err.message });
    }
  },

  'GET /health': async (req, res) => {
    jsonResponse(res, 200, { status: 'ok', instances: INSTANCES.length });
  }
};

/**
 * Match a request path against a route pattern
 * Returns params object if matched, null otherwise
 */
function matchRoute(pattern, path) {
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');

  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Handle incoming requests using route table
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;

  // Find matching route
  for (const [routeKey, handler] of Object.entries(routes)) {
    const [routeMethod, routePattern] = routeKey.split(' ');
    if (method !== routeMethod) continue;

    const params = matchRoute(routePattern, path);
    if (params !== null) {
      await handler(req, res, params);
      return;
    }
  }

  // 404 for unmatched routes
  jsonResponse(res, 404, { error: 'Not found' });
}

// =============================================================================
// Server Startup
// =============================================================================

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
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
