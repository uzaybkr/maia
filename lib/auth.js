import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { run, get } from './db.js';
import { PROD } from './env.js';

const scrypt = promisify(crypto.scrypt);

const SESSION_DAYS = 30;
const SECURE = PROD ? '; Secure' : '';

// DB stores only a hash, so a leaked DB can't be replayed as live sessions.
const hashId = (id) => crypto.createHash('sha256').update(id).digest('hex');

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

// Unknown emails still pay the scrypt cost so login timing doesn't reveal who has an account.
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

export async function verifyPassword(password, stored = DUMMY_HASH) {
  const [salt, hash] = stored.split(':');
  const candidate = await scrypt(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected) && stored !== DUMMY_HASH;
}

export function createSession(userId) {
  const id = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  run('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)', [hashId(id), userId, expiresAt]);
  return { id, expiresAt };
}

export function destroySession(id) {
  run('DELETE FROM sessions WHERE id = ?', [hashId(id)]);
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    try {
      cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch { /* malformed cookie value: ignore it rather than failing the request */ }
  }
  return cookies;
}

// Web uses the HttpOnly cookie; the iOS/Android apps send the same session id as a Bearer token.
export function sessionToken(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  return m ? m[1] : parseCookies(req).sid;
}

export function getSessionUser(req) {
  const sid = sessionToken(req);
  if (!sid) return null;
  const session = get('SELECT * FROM sessions WHERE id = ?', [hashId(sid)]);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    destroySession(sid);
    return null;
  }
  const user = get('SELECT id, email, email_verified_at, plan, premium_until, billing_source, stripe_customer_id, created_at FROM users WHERE id = ?', [session.user_id]);
  if (!user) return null;
  user.email_verified = !!user.email_verified_at;
  user.is_premium = isPremium(user);
  return user;
}

export const isPremium = (u) => !!u.premium_until && new Date(u.premium_until) > new Date();

// One-time email tokens ('verify' 24h, 'reset' 1h): stored hashed, single-use. A new verify link replaces the old one;
// reset links don't, so a stranger spamming "forgot password" can't invalidate the link the real user is about to click.
const TOKEN_TTL = { verify: 86400000, reset: 3600000 };

export function createToken(userId, purpose) {
  const token = crypto.randomBytes(32).toString('hex');
  if (purpose === 'verify') run('DELETE FROM verifications WHERE user_id = ? AND purpose = ?', [userId, purpose]);
  run('INSERT INTO verifications (token_hash, user_id, expires_at, purpose) VALUES (?, ?, ?, ?)',
    [hashId(token), userId, new Date(Date.now() + TOKEN_TTL[purpose]).toISOString(), purpose]);
  return token;
}

// Returns the user id the token belonged to, or null if it is unknown, used, expired or for another purpose.
export function consumeToken(token, purpose) {
  const row = get('SELECT * FROM verifications WHERE token_hash = ? AND purpose = ?', [hashId(String(token || '')), purpose]);
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return null;
  run('UPDATE verifications SET used_at = ? WHERE token_hash = ?', [new Date().toISOString(), row.token_hash]);
  return row.user_id;
}

export function destroyAllSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

export function sessionCookie(id) {
  const maxAge = SESSION_DAYS * 86400;
  return `sid=${id}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${SECURE}`;
}

export const clearCookie = `sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${SECURE}`;

// ponytail: in-memory per-process limiter for auth/abuse throttles, resets on restart. Move to Redis if running >1 instance.
// (The paid AI budget is counted from the database instead, so it survives restarts.)
const attempts = new Map();
let lastPrune = 0;
const recentHits = (key, windowMs, now) => (attempts.get(key)?.hits || []).filter((t) => now - t < windowMs);

// Records a hit and reports whether the key is now over its limit.
export function rateLimited(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  if (attempts.size > 10000 && now - lastPrune > 60000) { // bounded work even under a flood of unique keys
    lastPrune = now;
    for (const [k, v] of attempts) if (now - v.hits[v.hits.length - 1] > v.windowMs) attempts.delete(k);
  }
  const hits = recentHits(key, windowMs, now);
  hits.push(now);
  attempts.set(key, { hits, windowMs });
  return hits.length > max;
}

// Forget a key's hits, e.g. clear a per-email failure count after a successful login.
export const clearLimit = (key) => attempts.delete(key);
