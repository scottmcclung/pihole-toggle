# Pi-hole Toggle - Requirements Document

## Overview

A lightweight Node.js service that provides simple HTTP endpoints and a web UI to toggle Pi-hole v6 blocking across one or more instances. This service restores the "one URL call" behavior from Pi-hole v5, which was broken by v6's session-based authentication.

## Functional Requirements

### FR-1: Multi-Instance Management
- **FR-1.1**: Support managing multiple Pi-hole instances from a single interface
- **FR-1.2**: Configuration via JSON array in environment variable (`PIHOLE_INSTANCES`)
- **FR-1.3**: Each instance requires: name, URL, and app password
- **FR-1.4**: Actions (enable/disable) apply to ALL instances simultaneously
- **FR-1.5**: Status displayed individually for each instance

### FR-2: Blocking Control
- **FR-2.1**: Enable blocking on all instances via single action
- **FR-2.2**: Disable blocking for a specified duration (in minutes)
- **FR-2.3**: Supported durations: 30 min, 1 hr, 2 hrs, 4 hrs, 8 hrs, 12 hrs, 24 hrs
- **FR-2.4**: When blocking is disabled, allow adding time to existing timer
- **FR-2.5**: Timer applies to all instances uniformly

### FR-3: Simple URL Endpoints
- **FR-3.1**: `GET /enable` - Enable blocking on all instances, redirect to UI
- **FR-3.2**: `GET /disable/:minutes` - Disable blocking for X minutes, redirect to UI
- **FR-3.3**: `GET /` - Serve the web UI
- **FR-3.4**: Endpoints must work as bookmarkable URLs for mobile shortcuts

### FR-4: API Endpoints
- **FR-4.1**: `GET /api/status` - Return JSON status of all instances
- **FR-4.2**: `POST /api/enable` - Enable blocking, return JSON result
- **FR-4.3**: `POST /api/disable/:minutes` - Disable blocking, return JSON result

### FR-5: Web User Interface
- **FR-5.1**: Display status card for each Pi-hole instance
- **FR-5.2**: Show blocking status (Enabled/Disabled) with color coding (green/red)
- **FR-5.3**: Show status indicator dot for each instance
- **FR-5.4**: Display countdown timer when blocking is disabled
- **FR-5.5**: Show metrics for each instance: total queries, blocked queries, percentage blocked
- **FR-5.6**: Use icons to identify each metric to save space
- **FR-5.7**: Duration buttons always visible as primary action affordance
- **FR-5.8**: "Enable All" button visible only when all instances are disabled
- **FR-5.9**: Label changes contextually: "Disable all for:" vs "Add time to all:"
- **FR-5.10**: Page refresh should NOT re-trigger enable/disable actions

### FR-6: Live Updates
- **FR-6.1**: Poll Pi-hole instances every 5 seconds for status updates
- **FR-6.2**: Update countdown timer display every second
- **FR-6.3**: Reflect changes made through other interfaces (e.g., Pi-hole web UI)
- **FR-6.4**: Display "Last updated" timestamp

### FR-7: Error Handling
- **FR-7.1**: Display error state for instances that fail to connect
- **FR-7.2**: Show error indicator (yellow) for failed instances
- **FR-7.3**: Continue operating with other instances if one fails
- **FR-7.4**: Display transient error messages for action failures

## Non-Functional Requirements

### NFR-1: Zero Dependencies
- **NFR-1.1**: Use only Node.js built-in modules (http, https)
- **NFR-1.2**: No npm dependencies required

### NFR-2: Self-Contained UI
- **NFR-2.1**: All HTML, CSS, and JavaScript in a single html file
- **NFR-2.2**: No npm dependencies that require a build step, only CDN dependencies are allowed
- **NFR-2.3**: Inline styles and scripts

### NFR-3: Docker Deployment
- **NFR-3.1**: Provide Dockerfile using Node.js Alpine image
- **NFR-3.2**: Run as non-root user for security
- **NFR-3.3**: Provide docker-compose.yml for easy deployment
- **NFR-3.4**: Support running as sidecar to Pi-hole containers

### NFR-4: Pi-hole v6 API Compatibility
- **NFR-4.1**: Implement session-based authentication (SID + CSRF)
- **NFR-4.2**: Cache sessions to avoid "API seats exceeded" errors
- **NFR-4.3**: Automatically refresh expired sessions
- **NFR-4.4**: Handle session invalidation gracefully with retry logic
- **NFR-4.5**: Support HTTPS connections to Pi-hole instances
- **NFR-4.6**: Follow HTTP redirects (301, 302, 307, 308)

### NFR-5: Performance
- **NFR-5.1**: Fetch status and stats in parallel per instance
- **NFR-5.2**: Query all instances in parallel
- **NFR-5.3**: Session caching to reduce authentication overhead
- **NFR-5.4**: Compact number formatting (K, M) for large values

### NFR-6: Mobile-Friendly
- **NFR-6.1**: Responsive design that works on mobile devices
- **NFR-6.2**: Touch-friendly button sizes
- **NFR-6.3**: URL shortcuts work with iOS Shortcuts app
- **NFR-6.4**: URL shortcuts work with Android HTTP Shortcuts or bookmarks

### NFR-7: Security
- **NFR-7.1**: No authentication on the toggle service (trusted network only)
- **NFR-7.2**: Pi-hole app passwords stored in environment variables
- **NFR-7.3**: Passwords not exposed in logs or UI
- **NFR-7.4**: Run container as non-root user

### NFR-8: User Experience
- **NFR-8.1**: Modern, dark-themed glassmorphism UI
- **NFR-8.2**: Visual feedback during actions (button disabling, loading states)
- **NFR-8.3**: Color-coded status indicators (green=enabled, red=disabled, yellow=error)
- **NFR-8.4**: Timer display in H:MM:SS format for durations over 1 hour
- **NFR-8.5**: Metrics use icons for space efficiency

## Configuration

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `PIHOLE_INSTANCES` | Yes | JSON array of Pi-hole instance configurations |
| `PORT` | No | Server port (default: 3000) |

### Instance Configuration Schema
```json
{
  "name": "string - Display name for the instance",
  "url": "string - Pi-hole server URL (include port if not 80/443)",
  "password": "string - App password from Pi-hole Settings → API"
}
```

## API Response Schemas

### Status Response
```json
{
  "success": true,
  "instances": [
    {
      "name": "Primary",
      "url": "https://pihole1.local",
      "blocking": true,
      "timer": 0,
      "totalQueries": 12500,
      "blockedQueries": 3200,
      "percentBlocked": 25.6,
      "error": null
    }
  ]
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error message"
}
```
