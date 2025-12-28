# pihole-toggle

A tiny Node.js service that provides simple GET endpoints to toggle Pi-hole v6 blocking. Restores the "one URL call" behavior from Pi-hole v5.

## Why?

Pi-hole v6 replaced the simple API token auth with session-based authentication, breaking the ability to toggle blocking with a simple URL. This service handles the authentication complexity and exposes simple GET endpoints perfect for mobile shortcuts.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /enable` | Enable blocking |
| `GET /disable/:minutes` | Disable blocking for X minutes |
| `GET /status` | Get current blocking status |
| `GET /` | Service info |

## Setup

### 1. Generate an App Password in Pi-hole

1. Open your Pi-hole web UI
2. Go to **Settings** → **API**
3. Generate an **App Password**
4. Copy the password

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
PIHOLE_URL=http://192.168.1.2:80
PIHOLE_PASSWORD=your-app-password-here
```

### 3. Run with Docker Compose

```bash
docker compose up -d
```

## Usage

Once running, you can toggle blocking with simple GET requests:

```bash
# Enable blocking
curl http://localhost:3000/enable

# Disable blocking for 5 minutes
curl http://localhost:3000/disable/5

# Check status
curl http://localhost:3000/status
```

## Mobile Shortcuts

### iOS (Shortcuts app)
1. Create a new Shortcut
2. Add "Get Contents of URL" action
3. Set URL to `http://your-server:3000/disable/5`
4. Add to Home Screen

### Android (various methods)
- Use a shortcut app like "HTTP Shortcuts"
- Or create a bookmark widget pointing to the URL

## Running as a Pi-hole Sidecar

Add to your existing Pi-hole docker-compose.yml:

```yaml
services:
  pihole:
    image: pihole/pihole:latest
    # ... your existing pihole config ...

  pihole-toggle:
    build: ./pihole-toggle
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PIHOLE_URL=http://pihole:80
      - PIHOLE_PASSWORD=${PIHOLE_PASSWORD}
    depends_on:
      - pihole
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PIHOLE_URL` | Pi-hole server URL | `http://localhost` |
| `PIHOLE_PASSWORD` | Pi-hole app password | (required) |
| `PORT` | Port to listen on | `3000` |

## License

MIT
