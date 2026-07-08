'use strict';

/**
 * SQLite database initialization and schema management.
 * Uses better-sqlite3 with WAL mode for concurrency and durability.
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.sqlite');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// ── Initialize database connection ───────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');           // Write-Ahead Logging for better concurrency
db.pragma('foreign_keys = ON');            // Enforce referential integrity
db.pragma('synchronous = NORMAL');         // WAL mode makes NORMAL crash-safe
db.pragma('cache_size = -65536');          // 64 MB page cache
db.pragma('temp_store = MEMORY');          // Temporary tables in RAM
db.pragma('wal_autocheckpoint = 200');     // Checkpoint every ~800 KB (200 pages)

// ── Database schema ─────────────────────────────────────────────────────────

db.exec(`
-- Users: admin and operator accounts
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    UNIQUE NOT NULL,
  password_hash        TEXT    NOT NULL,
  role                 TEXT    NOT NULL CHECK(role IN ('admin','operator','station')),
  callsign             TEXT,
  phone                TEXT,
  color                TEXT    DEFAULT '#f5a623',
  shape                TEXT    DEFAULT 'triangle',
  active_session_token TEXT,
  created_at           INTEGER DEFAULT (unixepoch())
);

-- Races: event definitions with course/track and settings
CREATE TABLE IF NOT EXISTS races (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT    NOT NULL,
  date                TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'upcoming'
                               CHECK(status IN ('upcoming','active','past')),
  track_file          TEXT,
  track_path_index    INTEGER DEFAULT 0,
  viewer_token        TEXT    UNIQUE,
  time_format         TEXT    DEFAULT '24h' CHECK(time_format IN ('12h','24h')),
  geofence_radius     INTEGER DEFAULT 15,
  off_course_distance INTEGER DEFAULT 100,
  stopped_time        INTEGER DEFAULT 600,
  missing_timer       INTEGER DEFAULT 3600,
  alerts_enabled      INTEGER DEFAULT 1,
  messaging_enabled   INTEGER DEFAULT 0,
  viewer_map_enabled  INTEGER DEFAULT 1,
  leaderboard_enabled INTEGER DEFAULT 1,
  weather_enabled     INTEGER DEFAULT 0,
  weather_api_key     TEXT,
  weather_lat         REAL,
  weather_lon         REAL,
  mqtt_host           TEXT    DEFAULT 'apps.k7swi.org',
  mqtt_port_ws        INTEGER DEFAULT 9001,
  mqtt_port_tcp       INTEGER DEFAULT 1883,
  mqtt_user           TEXT    DEFAULT 'racetracker',
  mqtt_pass           TEXT    DEFAULT 'racetracker',
  mqtt_region         TEXT    DEFAULT 'US',
  mqtt_channel        TEXT    DEFAULT 'CourseSentry',
  mqtt_format         TEXT    DEFAULT 'json' CHECK(mqtt_format IN ('json','proto')),
  mqtt_psk            TEXT    DEFAULT 'AQ==',
  mqtt_rf_tech        TEXT    NOT NULL DEFAULT 'meshtastic',
  cloned_from         INTEGER REFERENCES races(id),
  created_at          INTEGER DEFAULT (unixepoch())
);

-- Heats: competitor groups within a race
CREATE TABLE IF NOT EXISTS heats (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id  INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  color    TEXT    NOT NULL DEFAULT '#58a6ff',
  shape    TEXT    NOT NULL DEFAULT 'circle'
           CHECK(shape IN ('circle','triangle','square','diamond','star','pentagon')),
  start_time INTEGER
);

-- Classes: participant categories (age groups, divisions, etc.)
CREATE TABLE IF NOT EXISTS classes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL
);

-- Stations: aid stations and course waypoints
CREATE TABLE IF NOT EXISTS stations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  lat           REAL    NOT NULL,
  lon           REAL    NOT NULL,
  type          TEXT    NOT NULL DEFAULT 'aid'
                CHECK(type IN ('start','finish','aid','checkpoint','start_finish','turnaround','netcontrol','repeater','rover')),
  cutoff_time   TEXT,
  course_order  INTEGER DEFAULT 0,
  created_at    INTEGER DEFAULT (unixepoch())
);

-- Personnel: race staff and volunteers
CREATE TABLE IF NOT EXISTS personnel (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  station_id  INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT    NOT NULL,
  tracker_id  TEXT,
  phone       TEXT,
  color       TEXT    DEFAULT '#f5a623',
  shape       TEXT    DEFAULT 'triangle',
  created_at  INTEGER DEFAULT (unixepoch())
);

-- Infrastructure nodes: digipeaters, iGates, repeaters, and standalone beacons.
-- Race-scoped (unlike tracker_registry, which is global across all races) so a
-- node can be pre-registered by an admin before it has ever beaconed, and so
-- "assigned to a station" mirrors how personnel are assigned to a station.
-- node_id is a loosely-matched TEXT field (against tracker_registry.node_id,
-- long_name, or short_name) rather than a hard FK, since tracker_registry is
-- unscoped and the same convention is already used by personnel.tracker_id.
CREATE TABLE IF NOT EXISTS infra_nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  node_type   TEXT    NOT NULL DEFAULT 'repeater'
              CHECK(node_type IN ('digipeater','igate','repeater','beacon','other')),
  node_id     TEXT,
  station_id  INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  notes       TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_infra_nodes_station ON infra_nodes(station_id);
-- Prevent double-registering the same physical node within a race; nodes not
-- yet matched to a beacon (node_id IS NULL) are exempt from the uniqueness check.
CREATE UNIQUE INDEX IF NOT EXISTS idx_infra_nodes_race_node
  ON infra_nodes(race_id, node_id) WHERE node_id IS NOT NULL;

-- Participants: racers/competitors
CREATE TABLE IF NOT EXISTS participants (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id           INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  bib               TEXT    NOT NULL,
  name              TEXT    NOT NULL,
  tracker_id        TEXT,
  heat_id           INTEGER REFERENCES heats(id) ON DELETE SET NULL,
  class_id          INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  age               INTEGER,
  phone             TEXT,
  emergency_contact TEXT,
  inreach_url       TEXT,
  status            TEXT    DEFAULT 'dns'
                    CHECK(status IN ('dns','active','dnf','finished')),
  start_time        INTEGER,
  finish_time       INTEGER,
  created_at        INTEGER DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_bib ON participants(race_id, bib);

-- Tracker registry: known nodes from MQTT/APRS networks
CREATE TABLE IF NOT EXISTS tracker_registry (
  node_id       TEXT    PRIMARY KEY,
  long_name     TEXT,
  short_name    TEXT,
  hw_model      INTEGER,
  battery_level INTEGER,
  voltage       REAL,
  last_seen     INTEGER,
  last_lat      REAL,
  last_lon      REAL,
  last_altitude REAL,
  last_speed    REAL,
  snr           REAL,
  rssi          INTEGER,
  rf_tech       TEXT
);
CREATE INDEX IF NOT EXISTS idx_registry_longname  ON tracker_registry(long_name);
CREATE INDEX IF NOT EXISTS idx_registry_shortname ON tracker_registry(short_name);

-- Tracker positions: historical location records
CREATE TABLE IF NOT EXISTS tracker_positions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id      INTEGER REFERENCES races(id),
  node_id      TEXT    NOT NULL,
  lat          REAL    NOT NULL,
  lon          REAL    NOT NULL,
  altitude     REAL,
  speed        REAL,
  heading      REAL,
  battery      INTEGER,
  snr          REAL,
  rssi         INTEGER,
  timestamp    INTEGER NOT NULL,
  rf_source    TEXT    DEFAULT 'meshtastic'
);
CREATE INDEX IF NOT EXISTS idx_positions_node ON tracker_positions(node_id, timestamp DESC);

-- Events: race milestones (starts, aid arrivals/departures, finishes, DNF)
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id        INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  participant_id INTEGER REFERENCES participants(id) ON DELETE CASCADE,
  event_type     TEXT    NOT NULL
                 CHECK(event_type IN
                   ('start','aid_arrive','aid_depart','finish',
                    'dnf','dns','off_course','stopped','manual')),
  station_id     INTEGER REFERENCES stations(id),
  timestamp      INTEGER NOT NULL,
  notes          TEXT,
  manual         INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_race        ON events(race_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_events_participant ON events(participant_id);

-- Courses: reusable track files (KML/GPX)
CREATE TABLE IF NOT EXISTS courses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  file_type  TEXT    NOT NULL CHECK(file_type IN ('kml','gpx')),
  path_index INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

-- CSV files: uploaded roster imports
CREATE TABLE IF NOT EXISTS csv_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Settings: global configuration key-value store
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Messages: APRS/MQTT inbound/outbound communications
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id      INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  direction    TEXT    NOT NULL CHECK(direction IN ('in','out')),
  from_node_id TEXT,
  to_node_id   TEXT,
  from_name    TEXT,
  to_name      TEXT,
  text         TEXT    NOT NULL,
  timestamp    INTEGER NOT NULL,
  status       TEXT    DEFAULT 'sent',
  read         INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_race      ON messages(race_id, timestamp DESC);

-- Performance indexes for hot-path queries (participant/personnel lookup on every position packet)
CREATE INDEX IF NOT EXISTS idx_participants_tracker ON participants(race_id, tracker_id);
CREATE INDEX IF NOT EXISTS idx_personnel_tracker    ON personnel(race_id, tracker_id);
CREATE INDEX IF NOT EXISTS idx_events_type          ON events(participant_id, event_type);
CREATE INDEX IF NOT EXISTS idx_positions_race_node  ON tracker_positions(race_id, node_id, timestamp DESC);
`);

// ── Schema migrations ────────────────────────────────────────────────────────
// Applied conditionally to support gradual schema evolution

// Add callsign field to users (for APRS messaging context)
try {
  db.prepare('ALTER TABLE users ADD COLUMN callsign TEXT').run();
} catch {}

// Add 'station' role to users (table rebuild required for CHECK constraint change)
{
  const usersDDL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (usersDDL && !usersDDL.sql.includes("'station'")) {
    db.exec(`
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    UNIQUE NOT NULL,
        password_hash TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK(role IN ('admin','operator','station')),
        callsign      TEXT,
        phone         TEXT,
        color         TEXT    DEFAULT '#f5a623',
        shape         TEXT    DEFAULT 'triangle',
        created_at    INTEGER DEFAULT (unixepoch())
      );
      INSERT INTO users_new (id, username, password_hash, role, callsign, created_at)
        SELECT id, username, password_hash, role, callsign, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
    `);
  }
}

// Add course_id and race_format to races
try {
  db.prepare('ALTER TABLE races ADD COLUMN course_id INTEGER REFERENCES courses(id)').run();
} catch {}
try {
  db.prepare("ALTER TABLE races ADD COLUMN race_format TEXT NOT NULL DEFAULT 'point_to_point'").run();
} catch {}

// Extend station types (support new checkpoint types)
{
  const stationsDDL = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='stations'").get();
  if (stationsDDL && !stationsDDL.sql.includes('netcontrol')) {
    db.exec(`
      CREATE TABLE stations_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
        name          TEXT    NOT NULL,
        lat           REAL    NOT NULL,
        lon           REAL    NOT NULL,
        type          TEXT    NOT NULL DEFAULT 'aid'
                      CHECK(type IN ('start','finish','aid','checkpoint','start_finish','turnaround','netcontrol','repeater','rover')),
        cutoff_time   TEXT,
        course_order  INTEGER DEFAULT 0,
        created_at    INTEGER DEFAULT (unixepoch())
      );
      INSERT INTO stations_new SELECT * FROM stations;
      DROP TABLE stations;
      ALTER TABLE stations_new RENAME TO stations;
    `);
  }
}

// Add personnel display fields (color/shape for map visualization)
try {
  db.prepare("ALTER TABLE personnel ADD COLUMN color TEXT DEFAULT '#f5a623'").run();
} catch {}
try {
  db.prepare("ALTER TABLE personnel ADD COLUMN shape TEXT DEFAULT 'triangle'").run();
} catch {}

// Add feature flags for per-race automation settings
try {
  db.prepare('ALTER TABLE races ADD COLUMN feat_missing INTEGER NOT NULL DEFAULT 1').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN feat_auto_log INTEGER NOT NULL DEFAULT 1').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN feat_auto_start INTEGER NOT NULL DEFAULT 1').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN feat_off_course INTEGER NOT NULL DEFAULT 1').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN feat_stopped INTEGER NOT NULL DEFAULT 1').run();
} catch {}

// Add checkpoint and station parameters
try {
  db.prepare('ALTER TABLE races ADD COLUMN checkpoint_radius INTEGER DEFAULT 50').run();
} catch {}

// Add speed display and units settings
try {
  db.prepare("ALTER TABLE races ADD COLUMN speed_units TEXT NOT NULL DEFAULT 'min_mile'").run();
} catch {}
try {
  db.prepare("ALTER TABLE races ADD COLUMN speed_display TEXT DEFAULT 'pace'").run();
} catch {}
try {
  db.prepare("ALTER TABLE races ADD COLUMN units TEXT NOT NULL DEFAULT 'us'").run();
} catch {}

// Add timing and start window fields
try {
  db.prepare('ALTER TABLE races ADD COLUMN clock_seconds INTEGER NOT NULL DEFAULT 1').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN start_time INTEGER').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN start_window_open INTEGER DEFAULT 0').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN start_window_ts INTEGER').run();
} catch {}
try {
  db.prepare('ALTER TABLE races ADD COLUMN start_clearance INTEGER DEFAULT 400').run();
} catch {}

// Add message status tracking
try {
  db.prepare("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'sent'").run();
} catch {}

// Add heat start time
try {
  db.prepare('ALTER TABLE heats ADD COLUMN start_time INTEGER').run();
} catch {}

// Add inReach URL field to participants
try {
  db.prepare('ALTER TABLE participants ADD COLUMN inreach_url TEXT').run();
} catch {}

// Add RF tracking fields
try {
  db.prepare("ALTER TABLE tracker_positions ADD COLUMN rf_source TEXT DEFAULT 'meshtastic'").run();
} catch {}
try {
  db.prepare('ALTER TABLE tracker_registry ADD COLUMN rf_tech TEXT').run();
} catch {}
try {
  db.prepare("ALTER TABLE races ADD COLUMN mqtt_rf_tech TEXT NOT NULL DEFAULT 'meshtastic'").run();
} catch {}

try { db.prepare("ALTER TABLE races ADD COLUMN speed_display TEXT NOT NULL DEFAULT 'pace'").run(); } catch {}
// Migrate existing speed_units → new fields (safe to run repeatedly; WHERE guards idempotency)
try {
  db.prepare("UPDATE races SET units='metric' WHERE speed_units IN ('min_km','kmh') AND units='us'").run();
  db.prepare("UPDATE races SET speed_display='speed' WHERE speed_units IN ('mph','kmh') AND speed_display='pace'").run();
} catch {}

try { db.prepare('ALTER TABLE users ADD COLUMN callsign TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE users ADD COLUMN phone TEXT').run(); } catch {}
try { db.prepare("ALTER TABLE users ADD COLUMN color TEXT DEFAULT '#f5a623'").run(); } catch {}
try { db.prepare("ALTER TABLE users ADD COLUMN shape TEXT DEFAULT 'triangle'").run(); } catch {}
try { db.prepare('ALTER TABLE personnel ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL').run(); } catch {}
try { db.prepare('CREATE INDEX IF NOT EXISTS idx_personnel_user ON personnel(user_id)').run(); } catch {}
try { db.prepare("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'enroute'").run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN tactical_callsign TEXT NOT NULL DEFAULT 'Net Control'").run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN viewer_show_names INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare("ALTER TABLE personnel ADD COLUMN color TEXT NOT NULL DEFAULT '#f5a623'").run(); } catch {}
try { db.prepare("ALTER TABLE personnel ADD COLUMN shape TEXT NOT NULL DEFAULT 'triangle'").run(); } catch {}
try { db.prepare('ALTER TABLE participants ADD COLUMN inreach_url TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN offline_maps INTEGER NOT NULL DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN offline_maps_status TEXT DEFAULT NULL').run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN rf_path TEXT NOT NULL DEFAULT 'WIDE1-1'").run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN viewer_nametags INTEGER NOT NULL DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN tnc_enabled INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare('ALTER TABLE users ADD COLUMN active_session_token TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE personnel ADD COLUMN is_rover INTEGER NOT NULL DEFAULT 0').run(); } catch {}
try { db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('aprs_igate_enabled', '0')").run(); } catch {}
// SPOT Trace satellite tracker feed — per-race shared page; a race uses SPOT
// whenever it has a feed ID set (no global toggle, mirroring the inReach poller).
try { db.prepare('ALTER TABLE races ADD COLUMN spot_feed_id TEXT').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN spot_feed_password TEXT').run(); } catch {}

// Clear all session tokens on startup — in-memory session store is wiped on restart
// so any stored tokens are orphaned and would wrongly block re-login.
db.prepare('UPDATE users SET active_session_token = NULL').run();

// Seed default admin on first run
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync('admin', 10);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')")
    .run(hash);
  console.log('[db] Created default admin user: admin / admin  — change this password!');
}

module.exports = db;
