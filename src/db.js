'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'portal.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT,
  password_hash TEXT NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS semesters (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  number      INTEGER,
  period      TEXT,
  description TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id          INTEGER PRIMARY KEY,
  cedula      TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL COLLATE NOCASE,
  name        TEXT,
  semester_id INTEGER REFERENCES semesters(id) ON DELETE SET NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  last_login  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subjects (
  id              INTEGER PRIMARY KEY,
  semester_id     INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  code            TEXT,
  professor       TEXT,
  professor_email TEXT,
  schedule        TEXT,
  classroom       TEXT,
  credits         INTEGER,
  description     TEXT,
  color           TEXT,
  position        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id         INTEGER PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  date       TEXT,
  content    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS materials (
  id            INTEGER PRIMARY KEY,
  subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  class_id      INTEGER REFERENCES classes(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('file', 'link')),
  url           TEXT,
  file_name     TEXT,
  original_name TEXT,
  mime          TEXT,
  size          INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  subject_id  INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'examen',
  date        TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  location    TEXT,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'student')),
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subjects_semester ON subjects(semester_id);
CREATE INDEX IF NOT EXISTS idx_classes_subject   ON classes(subject_id);
CREATE INDEX IF NOT EXISTS idx_materials_subject ON materials(subject_id);
CREATE INDEX IF NOT EXISTS idx_events_date       ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_subject    ON events(subject_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expires_at);
`);

/* ---------- helpers ---------- */

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

function clean(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

const all = (sql, ...params) => stmt(sql).all(...clean(params));
const get = (sql, ...params) => stmt(sql).get(...clean(params));
const run = (sql, ...params) => stmt(sql).run(...clean(params));

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* ---------- settings ---------- */

const DEFAULT_SETTINGS = {
  site_name: 'Economía 02',
  site_tagline: 'Portal académico',
  university: 'Universidad',
  period: '2026-II',
  allow_self_register: '0',
  welcome_message: 'Aquí encontrarás tus materias, materiales de apoyo y las fechas de evaluación.',
};

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, value);
}

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  );
}

/** Borra del disco los archivos que pertenecen a los materiales indicados. */
function unlinkFiles(rows) {
  for (const r of rows) {
    if (!r || !r.file_name) continue;
    const p = path.join(UPLOAD_DIR, path.basename(r.file_name));
    fs.rm(p, { force: true }, () => {});
  }
}

module.exports = {
  db,
  DATA_DIR,
  UPLOAD_DIR,
  all,
  get,
  run,
  tx,
  getSettings,
  setSetting,
  DEFAULT_SETTINGS,
  unlinkFiles,
};
