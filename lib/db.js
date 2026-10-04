import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './env.js';

fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = process.env.MAIA_DB || path.join(DATA_DIR, 'maia.db');

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA secure_delete = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rituals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    ritual_id TEXT NOT NULL,
    step_key TEXT NOT NULL,
    day TEXT NOT NULL,
    done_at TEXT NOT NULL,
    UNIQUE(ritual_id, day, step_key)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS examinations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    metrics TEXT NOT NULL,
    summary TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS verifications (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  -- Photos moved to their own never-backed-up file (lib/photos.js); drop any legacy copy from this DB.
  DROP TABLE IF EXISTS photos;

  -- Access per payment channel (stripe, app_store, play_store, dev); users.premium_until mirrors the longest one.
  CREATE TABLE IF NOT EXISTS entitlements (
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    plan TEXT NOT NULL,
    premium_until TEXT NOT NULL,
    PRIMARY KEY (user_id, source)
  );

  -- Append-only log of paid AI attempts, written before each provider call. Privacy delete never touches it,
  -- so deleting results can't reset the budget, and failed calls still count.
  CREATE TABLE IF NOT EXISTS ai_calls (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ai_calls_user ON ai_calls(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ai_calls_created ON ai_calls(created_at);

  CREATE INDEX IF NOT EXISTS idx_rituals_user ON rituals(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_exams_user ON examinations(user_id, kind, created_at);
`);

// Additive migrations: CREATE TABLE IF NOT EXISTS never alters an existing table, so new columns are added here.
function ensureColumn(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
ensureColumn('users', 'age_confirmed_at', 'TEXT');
ensureColumn('users', 'email_verified_at', 'TEXT');
ensureColumn('users', 'plan', 'TEXT');
ensureColumn('users', 'premium_until', 'TEXT');
ensureColumn('users', 'billing_source', 'TEXT');
ensureColumn('users', 'stripe_customer_id', 'TEXT');
ensureColumn('users', 'lang', "TEXT NOT NULL DEFAULT 'en'");
ensureColumn('verifications', 'purpose', "TEXT NOT NULL DEFAULT 'verify'");

export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}

export function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
