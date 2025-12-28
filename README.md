# pihole-toggle

A tiny Node.js service that provides simple endpoints to toggle Pi-hole v6 blocking across one or more instances. Restores the "one URL call" behavior from Pi-hole v5.

## Why?

Pi-hole v6 replaced the simple API token auth with session-based authentication, breaking the ability to toggle blocking with a simple URL. This service handles the authentication complexity and exposes simple GET endpoints perfect for mobile shortcuts.

## Features

- Modern web UI with live status updates
- Manage multiple Pi-hole instances from a single interface
- Individual status display for each instance
- Unified controls that apply to all instances
- Countdown timers when blocking is disabled
- Mobile-friendly design

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web UI with status and controls |
| `GET /enable` | Enable blocking on all instances |
| `GET /disable/:minutes` | Disable blocking for X minutes |
| `GET /api/status` | JSON status for all instances |

## Setup

### 1. Generate App Passwords in Pi-hole

For each Pi-hole instance:
1. Open the Pi-hole web UI
2. Go to **Settings** → **API**
3. Generate an **App Password**
4. Copy the password

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Configure your Pi-hole instance(s) as a JSON array:

```env
# Single instance
PIHOLE_INSTANCES='[{"name":"Pi-hole","url":"https://pihole.local","password":"app-password"}]'

# Multiple instances
PIHOLE_INSTANCES='[
  {"name":"Primary","url":"https://pihole1.local","password":"app-password-1"},
  {"name":"Secondary","url":"https://pihole2.local","password":"app-password-2"},
  {"name":"Backup 1","url":"https://pihole3.local","password":"app-password-3"},
  {"name":"Backup 2","url":"https://pihole4.local","password":"app-password-4"}
]'
```

### 3. Run with Docker Compose

```bash
docker compose up -d
```

## Usage

### Web Interface

Visit `http://localhost:3000` for the web UI with:
- Status cards for each Pi-hole instance
- Duration buttons to disable blocking
- Enable button when blocking is disabled
- Live countdown timers

### URL Shortcuts

Toggle blocking with simple GET requests:

```bash
# Enable blocking on all instances
curl http://localhost:3000/enable

# Disable blocking for 30 minutes on all instances
curl http://localhost:3000/disable/30
```

## Mobile Shortcuts

### iOS (Shortcuts app)
1. Create a new Shortcut
2. Add "Get Contents of URL" action
3. Set URL to `http://your-server:3000/disable/30`
4. Add to Home Screen

### Android
- Use a shortcut app like "HTTP Shortcuts"
- Or create a bookmark widget pointing to the URL

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PIHOLE_INSTANCES` | JSON array of Pi-hole configs (required) | - |
| `PORT` | Port to listen on | `3000` |

Each instance in the JSON array requires:
- `name`: Display name for the instance
- `url`: Pi-hole server URL (include port if not 80/443)
- `password`: App password from Pi-hole settings

## License

MIT
