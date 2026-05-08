# RaceTracker

Live race event safety and tracking system. Receives GPS positions from [Meshtastic](https://meshtastic.org) mesh radio nodes via MQTT, displays real-time participant locations on a map, and tracks timing events (start, aid stations, finish). Designed for trail runs, cycling events, and similar endurance races.

**Live at:** `https://apps.k7swi.org/RaceTracker/`

## Features

- Live map with participant positions (Leaflet + USGS Topo/Satellite, OSM)
- Leaderboard with % progress, pace, and ETA
- Automatic timing via configurable geofences at aid stations
- Heats (shape + color coded markers) and classes (age/gender groups)
- Off-course and missing tracker alerts
- Operator messaging to field personnel via MQTT
- Shareable public viewer link (no login required)
- CSV import for participants and stations
- KML/GPX route upload
- 3 roles: admin, operator, viewer

## Stack

- **Backend:** Node.js, Express, SQLite (better-sqlite3), WebSocket (ws), MQTT (mqtt.js), protobufjs
- **Frontend:** Vanilla JS, Leaflet.js
- **Auth:** bcrypt + express-session (no expiry)

---

## Installation

Tested on Ubuntu 22.04 / Debian 12. Run as a user with `sudo` access.

```bash
git clone https://github.com/jeepnjonny/RaceTracker.git
cd RaceTracker
bash setup.sh
```

This will:
1. Install Node.js 20 via NodeSource if not present
2. Copy files to `/srv/RaceTracker`
3. Run `npm install`
4. Create and start the `racetracker` systemd service (port 3000)
5. Install and reload the nginx location block

### HTTPS (optional)

```bash
bash setup.sh --ssl
```

Runs certbot for `apps.k7swi.org` and configures nginx with SSL automatically.

### nginx

The included `nginx-racetracker.conf` adds a `location /RaceTracker/` block that proxies to port 3000. Copy it into your existing nginx server block or `sites-available`:

```bash
sudo cp nginx-racetracker.conf /etc/nginx/sites-available/racetracker
sudo ln -s /etc/nginx/sites-available/racetracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### Default credentials

| Username | Password | Role  |
|----------|----------|-------|
| admin    | admin    | admin |

Change the password immediately in the **Admin → Users** tab.

### Environment

The service runs with these defaults — override in `/etc/systemd/system/racetracker.service` if needed:

| Variable   | Default | Description             |
|------------|---------|-------------------------|
| `PORT`     | `3000`  | HTTP/WS listen port     |
| `NODE_ENV` | `production` | Node environment   |

---

## Updating

From the cloned repo directory on your local machine:

```bash
git pull
bash update.sh
```

`update.sh` rsyncs changed files to `/srv/RaceTracker` (skipping `data/` and `node_modules/`) and restarts the service. The SQLite database in `data/` is never touched by updates.

---

## Service management

```bash
sudo systemctl status racetracker    # check status
sudo journalctl -u racetracker -f    # tail logs
sudo systemctl restart racetracker   # restart
```

---

## MQTT setup

In the **Admin → Races** panel, configure:

- **Broker host/port** — default `apps.k7swi.org:9001` (WebSocket) or `1883` (TCP)
- **Username/password** — default `racetracker / racetracker`
- **Region** — Meshtastic region code (e.g. `US`)
- **Channel** — MQTT channel name (e.g. `LongFast`)
- **PSK** — base64 AES-128 key for encrypted channels, or leave blank for JSON

The server subscribes to `msh/{region}/2/json/{channel}/#` and `msh/{region}/2/e/{channel}/#` and decodes Meshtastic ServiceEnvelope protobufs server-side.

---

## Optional TNC relay tools

RaceTracker now includes optional relay utilities for bridging a serial KISS TNC into the RaceTracker server.

- `tools/tnc-relay.js` — command-line relay agent that connects a KISS serial TNC to RaceTracker over HTTP/WebSocket.
- `tools/relay-app/main.js` — GUI launcher intended for packaging as a self-contained Windows relay app.
- `tools/package.json` — defines the `racetracker-tnc-relay` utility package and its `start` script.

Install the relay tools when needed:

```bash
cd tools
npm install
```

Run the command-line relay:

```bash
node tnc-relay.js --server http://<host>:3000 --user operator --pass secret --port COM3
```

Build the Windows GUI relay app from `tools/relay-app` if you want a packaged local executable:

```bash
cd tools/relay-app
npm install
npm run build
```

---

## Data directory

```
data/
  racetracker.db         # SQLite database (auto-created)
  uploads/
    tracks/              # uploaded KML/GPX files
    participants/        # uploaded CSV files
```

Back up `data/racetracker.db` to preserve race history.
