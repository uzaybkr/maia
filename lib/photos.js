import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PHOTO_DB } from './env.js';
import { seal, open } from './vault.js';

// Photos live in their own file so the main DB can be backed up without ever copying a photo.
// Production requires this file outside the backed-up data folder (lib/env.js); everything in it expires within 24h.
fs.mkdirSync(path.dirname(PHOTO_DB), { recursive: true });
export const photoDb = new DatabaseSync(PHOTO_DB);
photoDb.exec(`
  PRAGMA secure_delete = ON;
  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    sealed TEXT NOT NULL,
    consent_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_photos_user ON photos(user_id, kind);
  CREATE INDEX IF NOT EXISTS idx_photos_expiry ON photos(expires_at);
`);

export const PHOTO_KINDS = ['skin', 'hair', 'posture'];
const PHOTO_RE = /^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_PHOTO = 3 * 1024 * 1024;

export const cleanPhoto = (p) => (typeof p === 'string' && p.length <= MAX_PHOTO && PHOTO_RE.test(p) ? p : null);

// tzOffset is the browser's Date#getTimezoneOffset() (minutes, UTC = local + offset). Result is always <= 24h away.
export function endOfLocalDay(tzOffset, now = Date.now()) {
  const off = Number.isInteger(tzOffset) && Math.abs(tzOffset) <= 840 ? tzOffset : 0;
  const localNow = now - off * 60000;
  const nextLocalMidnight = (Math.floor(localNow / 86400000) + 1) * 86400000;
  return new Date(nextLocalMidnight + off * 60000).toISOString();
}

export function storePhoto(userId, kind, photo, tzOffset) {
  const now = new Date().toISOString();
  const expiresAt = endOfLocalDay(tzOffset);
  photoDb.prepare('INSERT INTO photos (id, user_id, kind, sealed, consent_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), userId, kind, seal(photo), now, now, expiresAt);
  return expiresAt;
}

export function purgeExpiredPhotos() {
  return photoDb.prepare('DELETE FROM photos WHERE expires_at <= ?').run(new Date().toISOString()).changes;
}

export function deletePhotos(userId) {
  photoDb.prepare('DELETE FROM photos WHERE user_id = ?').run(userId);
}

// Newest unexpired photo per kind, decrypted in memory only.
export function todaysPhotos(userId) {
  purgeExpiredPhotos();
  const rows = photoDb.prepare(`
    SELECT kind, sealed FROM photos WHERE rowid IN (SELECT MAX(rowid) FROM photos WHERE user_id = ? GROUP BY kind)
  `).all(userId);
  return Object.fromEntries(rows.map((r) => [r.kind, open(r.sealed)]));
}
