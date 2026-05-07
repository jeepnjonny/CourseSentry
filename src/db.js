'use strict';
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');     // WAL mode makes NORMAL crash-safe; avoids double-fsync per commit
db.pragma('cache_size = -65536');      // 64 MB page cache — reduce repeated disk reads
db.pragma('temp_store = MEMORY');      // temp tables/indexes in RAM
db.pragma('wal_autocheckpoint = 200'); // checkpoint every 200 pages (~800 KB) instead of 1000 — keeps WAL small

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    UNIQUE NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK(role IN ('admin','operator')),
  created_at    INTEGER DEFAULT (unixepoch())
);

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
  mqtt_channel        TEXT    DEFAULT 'RaceTracker',
  mqtt_format         TEXT    DEFAULT 'json' CHECK(mqtt_format IN ('json','proto')),
  mqtt_psk            TEXT    DEFAULT 'AQ==',
  cloned_from         INTEGER REFERENCES races(id),
  created_at          INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS heats (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id  INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name     TEXT    NOT NULL,
  color    TEXT    NOT NULL DEFAULT '#58a6ff',
  shape    TEXT    NOT NULL DEFAULT 'circle'
           CHECK(shape IN ('circle','triangle','square','diamond','star','pentagon'))
);

CREATE TABLE IF NOT EXISTS classes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS stations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id       INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  lat           REAL    NOT NULL,
  lon           REAL    NOT NULL,
  type          TEXT    NOT NULL DEFAULT 'aid'
                CHECK(type IN ('start','finish','aid','checkpoint')),
  cutoff_time   TEXT,
  course_order  INTEGER DEFAULT 0,
  created_at    INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS personnel (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id     INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  station_id  INTEGER REFERENCES stations(id) ON DELETE SET NULL,
  name        TEXT    NOT NULL,
  tracker_id  TEXT,
  phone       TEXT,
  created_at  INTEGER DEFAULT (unixepoch())
);

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
  status            TEXT    DEFAULT 'dns'
                    CHECK(status IN ('dns','active','dnf','finished')),
  start_time        INTEGER,
  finish_time       INTEGER,
  created_at        INTEGER DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_bib ON participants(race_id, bib);

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
  rssi          INTEGER
);

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
  timestamp    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_node     ON tracker_positions(node_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_registry_longname  ON tracker_registry(long_name);
CREATE INDEX IF NOT EXISTS idx_registry_shortname ON tracker_registry(short_name);

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

CREATE TABLE IF NOT EXISTS courses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  file_type  TEXT    NOT NULL CHECK(file_type IN ('kml','gpx')),
  path_index INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS csv_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

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
  read         INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_race ON messages(race_id, timestamp DESC);
`);

// Migrations
try { db.prepare('ALTER TABLE races ADD COLUMN course_id INTEGER REFERENCES courses(id)').run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN race_format TEXT NOT NULL DEFAULT 'point_to_point'").run(); } catch {}

// Migrate stations table to add new types (start_finish, turnaround, netcontrol, repeater)
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
                      CHECK(type IN ('start','finish','aid','checkpoint','start_finish','turnaround','netcontrol','repeater')),
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

// Per-race feature flag migrations
try { db.prepare('ALTER TABLE races ADD COLUMN feat_missing  INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN feat_auto_log INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN feat_auto_start INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN feat_off_course INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN feat_stopped INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN checkpoint_radius INTEGER DEFAULT 50').run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN speed_units TEXT NOT NULL DEFAULT 'min_mile'").run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN clock_seconds INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN start_time INTEGER').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN start_window_open INTEGER DEFAULT 0').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN start_window_ts INTEGER').run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN start_clearance INTEGER DEFAULT 400').run(); } catch {}
try { db.prepare('ALTER TABLE heats ADD COLUMN start_time INTEGER').run(); } catch {}
try { db.prepare("ALTER TABLE tracker_positions ADD COLUMN rf_source TEXT DEFAULT 'meshtastic'").run(); } catch {}
try { db.prepare('ALTER TABLE tracker_registry ADD COLUMN rf_tech TEXT').run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN mqtt_rf_tech TEXT NOT NULL DEFAULT 'meshtastic'").run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN units TEXT NOT NULL DEFAULT 'us'").run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN speed_display TEXT NOT NULL DEFAULT 'pace'").run(); } catch {}
// Migrate existing speed_units → new fields (safe to run repeatedly; WHERE guards idempotency)
try {
  db.prepare("UPDATE races SET units='metric' WHERE speed_units IN ('min_km','kmh') AND units='us'").run();
  db.prepare("UPDATE races SET speed_display='speed' WHERE speed_units IN ('mph','kmh') AND speed_display='pace'").run();
} catch {}

try { db.prepare('ALTER TABLE users ADD COLUMN callsign TEXT').run(); } catch {}
try { db.prepare("ALTER TABLE messages ADD COLUMN status TEXT DEFAULT 'enroute'").run(); } catch {}
try { db.prepare("ALTER TABLE races ADD COLUMN tactical_callsign TEXT NOT NULL DEFAULT 'Net Control'").run(); } catch {}
try { db.prepare('ALTER TABLE races ADD COLUMN viewer_show_names INTEGER NOT NULL DEFAULT 1').run(); } catch {}
try { db.prepare("ALTER TABLE personnel ADD COLUMN color TEXT NOT NULL DEFAULT '#f5a623'").run(); } catch {}
try { db.prepare("ALTER TABLE personnel ADD COLUMN shape TEXT NOT NULL DEFAULT 'triangle'").run(); } catch {}

// Seed default admin on first run
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  const hash = bcrypt.hashSync('admin', 10);
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')")
    .run(hash);
  console.log('[db] Created default admin user: admin / admin  — change this password!');
}

module.exports = db;
