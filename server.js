import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PORT, APP_URL, PROD } from './lib/env.js';
import { run, get, all } from './lib/db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions, getSessionUser, sessionCookie, clearCookie,
  sessionToken, rateLimited, clearLimit, createToken, consumeToken, isPremium,
} from './lib/auth.js';
import {
  PLANS, setEntitlement, stripeEnabled, createCheckout, createPortal, verifyStripeSignature, applyStripeEvent, cancelStripeSubscriptions,
  revenueCatEnabled, verifyRevenueCatAuth, applyRevenueCatEvent, syncRevenueCat,
} from './lib/billing.js';
import { sendVerificationEmail, sendPasswordResetEmail, emailEnabled } from './lib/mail.js';
import { generateRitual, generateChatReply, examinePhoto, starterRitual } from './lib/ai.js';
import { PHOTO_KINDS, cleanPhoto, storePhoto, purgeExpiredPhotos, deletePhotos, todaysPhotos } from './lib/photos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 4 * 1024 * 1024; // one base64 photo (max 3MB) plus JSON
const DAY_MS = 24 * 60 * 60 * 1000;

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  ...(PROD && { 'strict-transport-security': 'max-age=31536000; includeSubDomains' }),
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

// JSON only: a cross-site text/plain form post can't reach the API (blocks login CSRF). Oversized bodies are
// drained and discarded so the client still receives a clean 413.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(httpError(413, 'Payload too large'));
      req.rawBody = Buffer.concat(chunks); // webhook signatures are computed over the exact bytes
      if (!size) return resolve({});
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(httpError(415, 'Content-Type must be application/json'));
      try {
        resolve(JSON.parse(req.rawBody.toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

function requireUser(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    send(res, 401, { error: 'Not authenticated' });
    return null;
  }
  return user;
}

// AI features and purchases need a confirmed email: blocks throwaway accounts from burning the paid AI budget.
function requireVerifiedUser(req, res) {
  const user = requireUser(req, res);
  if (user && !user.email_verified) {
    send(res, 403, { error: 'Please confirm your email first', code: 'unverified' });
    return null;
  }
  return user;
}

const meBody = (u) => ({
  id: u.id,
  email: u.email,
  email_verified: !!u.email_verified_at,
  onboarding_complete: hasProfile(u.id),
  is_premium: isPremium(u),
  plan: u.plan || null,
  premium_until: u.premium_until || null,
  billing_source: u.billing_source || null,
  lang: u.lang || 'en',
});

// Native apps can't use the HttpOnly cookie across origins, so they get the session id in the body instead.
const authBody = (req, user, session) => ({ ...meBody(user), ...(req.headers['x-maia-client'] === 'native' && { token: session.id }) });

// Capacitor 8 serves the bundled app from these origins (iOS / Android). Bearer-only, so no credentialed CORS is needed.
const NATIVE_ORIGINS = new Set(['capacitor://localhost', 'https://localhost']);

// Local development without an email service: hand the link to the client so the confirm screen can offer it.
// Never in production: env.js refuses to boot there without RESEND_API_KEY.
const DEV_LINKS = !PROD && !emailEnabled;

async function issueVerification(user) {
  const link = `${APP_URL}/verify?token=${createToken(user.id, 'verify')}`;
  await sendVerificationEmail(user.email, link, user.lang).catch((err) => console.error('[mail]', err.message));
  return DEV_LINKS ? { dev_verify_url: link } : {};
}

// Behind a proxy, only the entry the proxy itself appended (the rightmost) is trustworthy; the rest is client-supplied.
function clientIp(req) {
  const fwd = process.env.TRUST_PROXY && req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',').at(-1).trim() : req.socket.remoteAddress) || 'unknown';
}

const TOO_MANY = { error: 'Too many attempts, try again later' };
const LANGS = new Set(['en', 'tr']); // the app's languages; Maia writes rituals, notes and replies in the user's

function getProfile(userId) {
  const row = get('SELECT data FROM profiles WHERE user_id = ?', [userId]);
  return row ? JSON.parse(row.data) : null;
}

const hasProfile = (userId) => !!get('SELECT 1 AS x FROM profiles WHERE user_id = ?', [userId]);

function getLatestRitual(userId) {
  return get('SELECT * FROM rituals WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
}

// Newest N messages, returned oldest-first; rowid breaks same-millisecond ties.
function recentMessages(userId, limit) {
  return all('SELECT role, content, created_at FROM messages WHERE user_id = ? ORDER BY rowid DESC LIMIT ?', [userId, limit]).reverse();
}

// Client sends its local date so "today" follows the user's timezone, not the server's.
const dayOf = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : new Date().toISOString().slice(0, 10));

function ritualProgress(ritualId, day) {
  return all('SELECT step_key FROM checkins WHERE ritual_id = ? AND day = ?', [ritualId, day]).map((r) => r.step_key);
}

// Paid AI budget. Every attempt is logged in ai_calls BEFORE the provider is called, so failed calls count, deleting
// results can't reset it, and restarts can't either. Check + insert run synchronously, so parallel requests can't
// all slip past. MAIA_AI_DAILY_CAP is a global kill-switch across all users; set it to what your budget allows.
// Limits are [max calls, window] per kind. A new ritual runs on the big model, so it's the scarce one; one check-in
// is up to 3 photo analyses (skin, hair, posture). Free has no AI at launch (a starter ritual costs nothing); a free
// tier can be opened later by adding limits here, e.g. { examination: [3, WEEK_MS] }.
const WEEK_MS = 7 * DAY_MS;
const AI_LIMITS = {
  free: {},
  premium: { examination: [6, DAY_MS], ritual: [3, WEEK_MS], revise: [3, DAY_MS], chat: [15, DAY_MS] },
};
const AI_PER_MINUTE = 10;
const AI_GLOBAL = Number(process.env.MAIA_AI_DAILY_CAP) || 2000;
const countCalls = (sinceMs, userId, kind) => get(
  `SELECT COUNT(*) AS n FROM ai_calls WHERE created_at > ?${userId ? ' AND user_id = ?' : ''}${kind ? ' AND kind = ?' : ''}`,
  [new Date(Date.now() - sinceMs).toISOString(), ...(userId ? [userId] : []), ...(kind ? [kind] : [])],
).n;

function takeAiCall(user, kind) {
  const [max, windowMs] = AI_LIMITS[user.is_premium ? 'premium' : 'free'][kind] || [0, DAY_MS];
  if (countCalls(windowMs, user.id, kind) >= max || countCalls(60 * 1000, user.id) >= AI_PER_MINUTE || countCalls(DAY_MS) >= AI_GLOBAL) return false;
  run('INSERT INTO ai_calls (user_id, kind, created_at) VALUES (?, ?, ?)', [user.id, kind, new Date().toISOString()]);
  return true;
}
const AI_LIMIT = { error: 'That’s all for now. Maia will be ready again soon.' };

// Periodic cleanup: expired photos (end of the user's day) and AI-call records older than the longest limit window.
function housekeeping() {
  purgeExpiredPhotos();
  run('DELETE FROM ai_calls WHERE created_at < ?', [new Date(Date.now() - WEEK_MS - DAY_MS).toISOString()]);
}

const routes = {
  'GET /healthz': async (req, res) => send(res, 200, { ok: true }),

  'POST /api/signup': async (req, res, body) => {
    if (rateLimited(`auth:${clientIp(req)}`)) return send(res, 429, TOO_MANY);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email.includes('@') || email.length > 254 || password.length < 8) {
      return send(res, 400, { error: 'Valid email and password (8+ chars) required' });
    }
    if (body.age_confirmed !== true) return send(res, 400, { error: 'Maia is for adults: please confirm you are 18 or older' });
    if (get('SELECT id FROM users WHERE email = ?', [email])) return send(res, 409, { error: 'Account already exists' });
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const hash = await hashPassword(password);
    try {
      run('INSERT INTO users (id, email, password_hash, created_at, age_confirmed_at, lang) VALUES (?, ?, ?, ?, ?, ?)',
        [id, email, hash, now, now, LANGS.has(body.lang) ? body.lang : 'en']);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return send(res, 409, { error: 'Account already exists' }); // lost a concurrent-signup race
      throw err;
    }
    const user = get('SELECT * FROM users WHERE id = ?', [id]);
    const dev = await issueVerification(user);
    const session = createSession(id);
    send(res, 200, { ...authBody(req, user, session), ...dev }, { 'set-cookie': sessionCookie(session.id) });
  },

  'GET /verify': async (req, res, body, url) => {
    const userId = consumeToken(url.searchParams.get('token'), 'verify');
    if (userId) run('UPDATE users SET email_verified_at = ? WHERE id = ?', [new Date().toISOString(), userId]);
    res.writeHead(302, { ...SECURITY_HEADERS, location: userId ? '/#/verified' : '/#/verify-failed' });
    res.end();
  },

  'POST /api/verify/resend': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.email_verified) return send(res, 200, { ok: true, already: true });
    if (rateLimited(`verify:${user.id}`, 3, 60 * 60 * 1000)) return send(res, 429, { error: 'Please wait a bit before requesting another email' });
    send(res, 200, { ok: true, ...(await issueVerification(user)) });
  },

  'POST /api/login': async (req, res, body) => {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    // Per-IP stops one attacker. Per-email stops a botnet spreading guesses on one account across many IPs. The email
    // attempt is counted up front (so parallel guesses can't race past the cap) and cleared on success, so only
    // failures accumulate, with a higher cap than per-IP.
    const emailKey = `login:${email}`;
    if (rateLimited(`auth:${clientIp(req)}`) || rateLimited(emailKey, 20)) return send(res, 429, TOO_MANY);
    const password = String(body.password || '');
    const user = get('SELECT * FROM users WHERE email = ?', [email]);
    if (!(await verifyPassword(password, user?.password_hash))) {
      return send(res, 401, { error: 'Invalid email or password' });
    }
    clearLimit(emailKey);
    const session = createSession(user.id);
    send(res, 200, authBody(req, user, session), { 'set-cookie': sessionCookie(session.id) });
  },

  'POST /api/password/forgot': async (req, res, body) => {
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    if (rateLimited(`forgot:${clientIp(req)}`)) return send(res, 429, TOO_MANY);
    const user = get('SELECT id, email, lang FROM users WHERE email = ?', [email]);
    // Past the per-email cap, answer the same but send nothing: the user's existing links stay valid.
    if (user && !rateLimited(`forgot:${email}`, 5, 60 * 60 * 1000)) {
      const link = `${APP_URL}/#/reset?token=${createToken(user.id, 'reset')}`;
      await sendPasswordResetEmail(user.email, link, user.lang).catch((err) => console.error('[mail]', err.message));
    }
    send(res, 200, { ok: true }); // same answer whether or not the account exists
  },

  'POST /api/password/reset': async (req, res, body) => {
    const password = String(body.password || '');
    if (password.length < 8) return send(res, 400, { error: 'Password must be at least 8 characters' });
    const userId = consumeToken(body.token, 'reset');
    if (!userId) return send(res, 400, { error: 'This reset link is invalid or has expired' });
    // Reaching the reset link also proves the user owns the email address.
    run('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?',
      [await hashPassword(password), new Date().toISOString(), userId]);
    run("DELETE FROM verifications WHERE user_id = ? AND purpose = 'reset'", [userId]); // other outstanding reset links die too
    destroyAllSessions(userId);
    send(res, 200, { ok: true });
  },

  'POST /api/logout': async (req, res) => {
    const sid = sessionToken(req);
    if (sid) destroySession(sid);
    send(res, 200, { ok: true }, { 'set-cookie': clearCookie });
  },

  'GET /api/me': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    send(res, 200, meBody(user));
  },

  'POST /api/settings': async (req, res, body) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!LANGS.has(body.lang)) return send(res, 400, { error: 'Unsupported language' });
    run('UPDATE users SET lang = ? WHERE id = ?', [body.lang, user.id]);
    send(res, 200, { lang: body.lang });
  },

  'POST /api/onboarding': async (req, res, body) => {
    const user = requireUser(req, res);
    if (!user) return;
    const profile = {
      // Goals go into every AI prompt: only short strings, or one user could inflate every paid call.
      goals: (Array.isArray(body.goals) ? body.goals : []).filter((g) => typeof g === 'string').slice(0, 8).map((g) => g.slice(0, 60)),
      preferences: String(body.preferences || '').slice(0, 500),
      sensitivities: String(body.sensitivities || '').slice(0, 500),
      budget: String(body.budget || '').slice(0, 100),
      region: String(body.region || '').slice(0, 100),
      climate: String(body.climate || '').slice(0, 100),
    };
    run(
      'INSERT INTO profiles (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
      [user.id, JSON.stringify(profile), new Date().toISOString()]
    );
    send(res, 200, { ok: true });
  },

  'GET /api/profile': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    send(res, 200, { profile: getProfile(user.id) });
  },

  'GET /api/examinations': async (req, res, body, url) => {
    const user = requireUser(req, res);
    if (!user) return;
    const kind = url.searchParams.get('kind');
    if (!PHOTO_KINDS.includes(kind)) return send(res, 400, { error: 'kind must be skin, hair or posture' });
    const rows = all('SELECT id, kind, metrics, summary, source, created_at FROM examinations WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 120', [user.id, kind]);
    send(res, 200, { examinations: rows.map((r) => ({ ...r, metrics: JSON.parse(r.metrics) })) });
  },

  'POST /api/examinations': async (req, res, body) => {
    const user = requireVerifiedUser(req, res);
    if (!user) return;
    if (!user.is_premium) return send(res, 402, { error: 'Photo analysis is part of Maia Premium' });
    const kind = PHOTO_KINDS.includes(body.kind) ? body.kind : null;
    const photo = cleanPhoto(body.photo);
    if (!kind || !photo) return send(res, 400, { error: 'A skin, hair or posture photo (JPEG/PNG/WebP, max 3MB) is required' });
    if (body.consent !== true) return send(res, 400, { error: 'Photo consent is required' });
    if (!takeAiCall(user, 'examination')) return send(res, 429, AI_LIMIT);
    const { examination, source } = await examinePhoto(kind, photo, user.lang);
    if (!examination) return send(res, 503, { error: 'Maia couldn’t analyze this photo right now. Please try again in a few minutes.' });
    // Sealed and kept only until the end of the user's local day, then purged; the examination is what we keep.
    const photoExpiresAt = storePhoto(user.id, kind, photo, body.tzOffset);
    const row = { id: crypto.randomUUID(), kind, ...examination, source, created_at: new Date().toISOString() };
    run('INSERT INTO examinations (id, user_id, kind, metrics, summary, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [row.id, user.id, kind, JSON.stringify(row.metrics), row.summary, source, row.created_at]);
    send(res, 200, { examination: row, photoExpiresAt });
  },

  'POST /api/ritual/generate': async (req, res) => {
    const user = requireVerifiedUser(req, res);
    if (!user) return;
    const profile = getProfile(user.id);
    if (!profile) return send(res, 400, { error: 'Complete onboarding first' });
    let ritual, source;
    if (user.is_premium) {
      if (!takeAiCall(user, 'ritual')) return send(res, 429, AI_LIMIT);
      ({ ritual, source } = await generateRitual({ ...profile, photos: todaysPhotos(user.id) }, null, user.lang));
    } else {
      // Free costs no AI: a starter ritual built from the onboarding answers. Capped only to stop row spam.
      if (rateLimited(`starter:${user.id}`, 10, DAY_MS)) return send(res, 429, AI_LIMIT);
      ritual = starterRitual(profile, user.lang);
      source = 'starter';
    }
    const id = crypto.randomUUID();
    run('INSERT INTO rituals (id, user_id, content, source, created_at) VALUES (?, ?, ?, ?, ?)', [id, user.id, JSON.stringify(ritual), source, new Date().toISOString()]);
    send(res, 200, { id, ritual, source, progress: [] });
  },

  'GET /api/ritual/today': async (req, res, body, url) => {
    const user = requireUser(req, res);
    if (!user) return;
    const row = getLatestRitual(user.id);
    if (!row) return send(res, 200, { ritual: null });
    const day = dayOf(url.searchParams.get('day'));
    send(res, 200, { id: row.id, ritual: JSON.parse(row.content), source: row.source, createdAt: row.created_at, progress: ritualProgress(row.id, day) });
  },

  'POST /api/ritual/revise': async (req, res, body) => {
    const user = requireVerifiedUser(req, res);
    if (!user) return;
    if (!user.is_premium) return send(res, 402, { error: 'Upgrade to revise your ritual' });
    const profile = getProfile(user.id);
    const current = getLatestRitual(user.id);
    if (!profile || !current) return send(res, 400, { error: 'No ritual to revise yet' });
    if (!takeAiCall(user, 'revise')) return send(res, 429, AI_LIMIT);
    const action = ['simplify', 'swap', 'lower_cost'].includes(body.action) ? body.action : 'simplify';
    const note = String(body.note || '').slice(0, 300);
    // Revisions work from the current ritual text; photos are not re-sent to the AI provider.
    const { ritual, source } = await generateRitual({ ...profile, photos: {} }, { action, note, current: JSON.parse(current.content) }, user.lang);
    const id = crypto.randomUUID();
    run('INSERT INTO rituals (id, user_id, content, source, created_at) VALUES (?, ?, ?, ?, ?)', [id, user.id, JSON.stringify(ritual), source, new Date().toISOString()]);
    send(res, 200, { id, ritual, source, progress: [] });
  },

  'POST /api/ritual/checkin': async (req, res, body) => {
    const user = requireUser(req, res);
    if (!user) return;
    const ritualId = String(body.ritualId || '');
    const stepKey = String(body.stepKey || '').slice(0, 40);
    const day = dayOf(body.day);
    if (!ritualId || !stepKey) return send(res, 400, { error: 'ritualId and stepKey required' });
    if (!get('SELECT id FROM rituals WHERE id = ? AND user_id = ?', [ritualId, user.id])) return send(res, 404, { error: 'Ritual not found' });
    run('INSERT OR IGNORE INTO checkins (id, user_id, ritual_id, step_key, day, done_at) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), user.id, ritualId, stepKey, day, new Date().toISOString()]);
    send(res, 200, { progress: ritualProgress(ritualId, day) });
  },

  'GET /api/chat/history': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    send(res, 200, { messages: recentMessages(user.id, 100) });
  },

  'POST /api/chat': async (req, res, body) => {
    const user = requireVerifiedUser(req, res);
    if (!user) return;
    if (!user.is_premium) return send(res, 402, { error: 'Upgrade to chat with Maia' });
    const message = String(body.message || '').trim().slice(0, 2000);
    if (!message) return send(res, 400, { error: 'message required' });
    if (!takeAiCall(user, 'chat')) return send(res, 429, AI_LIMIT);
    const profile = getProfile(user.id);
    const ritualRow = getLatestRitual(user.id);
    const ritual = ritualRow ? JSON.parse(ritualRow.content) : null;
    const history = recentMessages(user.id, 20);
    run('INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', [crypto.randomUUID(), user.id, 'user', message, new Date().toISOString()]);
    const { reply, source } = await generateChatReply(profile, ritual, history, message, user.lang);
    run('INSERT INTO messages (id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)', [crypto.randomUUID(), user.id, 'assistant', reply, new Date().toISOString()]);
    send(res, 200, { reply, source });
  },

  'POST /api/privacy/delete': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    deletePhotos(user.id);
    for (const table of ['examinations', 'messages']) run(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]);
    send(res, 200, { ok: true });
  },

  'POST /api/account/delete': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.stripe_customer_id && stripeEnabled()) {
      try {
        await cancelStripeSubscriptions(user.stripe_customer_id);
      } catch (err) {
        console.error('[billing] cancel on delete failed:', err.message);
        return send(res, 502, { error: 'We couldn’t cancel your subscription, so your account was not deleted. Please try again.' });
      }
    }
    deletePhotos(user.id);
    for (const table of ['sessions', 'profiles', 'rituals', 'checkins', 'messages', 'examinations', 'verifications', 'entitlements']) {
      run(`DELETE FROM ${table} WHERE user_id = ?`, [user.id]);
    }
    // Keep today's AI-call rows for the global cap, but unlinked from the deleted person.
    run("UPDATE ai_calls SET user_id = 'deleted' WHERE user_id = ?", [user.id]);
    run('DELETE FROM users WHERE id = ?', [user.id]);
    send(res, 200, { ok: true }, { 'set-cookie': clearCookie });
  },

  'GET /api/billing/plans': async (req, res) => {
    send(res, 200, { plans: PLANS, limits: AI_LIMITS, stripe: stripeEnabled(), devUpgrade: !PROD && !stripeEnabled() });
  },

  'POST /api/billing/checkout': async (req, res, body) => {
    const user = requireVerifiedUser(req, res);
    if (!user) return;
    if (user.is_premium) return send(res, 409, { error: 'You already have Premium' });
    if (!stripeEnabled()) return send(res, 503, { error: 'Payments are not configured yet' });
    if (!PLANS.some((p) => p.id === body.plan)) return send(res, 400, { error: 'Unknown plan' });
    if (rateLimited(`billing:${user.id}`, 10, 60 * 60 * 1000)) return send(res, 429, TOO_MANY);
    send(res, 200, { url: await createCheckout(user, body.plan, APP_URL) });
  },

  'POST /api/billing/portal': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!stripeEnabled()) return send(res, 503, { error: 'Payments are not configured yet' });
    if (!user.stripe_customer_id) return send(res, 400, { error: 'No web subscription to manage' });
    if (rateLimited(`billing:${user.id}`, 10, 60 * 60 * 1000)) return send(res, 429, TOO_MANY);
    send(res, 200, { url: await createPortal(user, APP_URL) });
  },

  'POST /api/billing/stripe-webhook': async (req, res, body) => {
    if (!verifyStripeSignature(req.rawBody, req.headers['stripe-signature'])) return send(res, 400, { error: 'Invalid signature' });
    await applyStripeEvent(body); // a throw here returns 500, so Stripe retries the event
    send(res, 200, { received: true });
  },

  'POST /api/billing/revenuecat-webhook': async (req, res, body) => {
    if (!verifyRevenueCatAuth(req.headers.authorization)) return send(res, 401, { error: 'Unauthorized' });
    applyRevenueCatEvent(body.event);
    send(res, 200, { received: true });
  },

  'POST /api/billing/revenuecat-sync': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!revenueCatEnabled()) return send(res, 503, { error: 'In-app purchases are not configured yet' });
    if (rateLimited(`billing:${user.id}`, 10, 60 * 60 * 1000)) return send(res, 429, TOO_MANY);
    await syncRevenueCat(user.id);
    send(res, 200, meBody(get('SELECT * FROM users WHERE id = ?', [user.id])));
  },

  'POST /api/subscribe': async (req, res) => {
    // Local-dev test upgrade only: gone in production and whenever real payments are configured.
    if (PROD || stripeEnabled()) return send(res, 404, { error: 'Not found' });
    const user = requireVerifiedUser(req, res);
    if (!user) return;
    setEntitlement(user.id, { plan: 'monthly', premiumUntil: new Date(Date.now() + 30 * 86400000).toISOString(), source: 'dev' });
    send(res, 200, { is_premium: true });
  },
};

const server = http.createServer(async (req, res) => {
  try {
    if (NATIVE_ORIGINS.has(req.headers.origin)) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-allow-headers', 'content-type, authorization, x-maia-client');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return serveStatic(req, res, url.pathname);
    const body = req.method === 'POST' ? await readBody(req) : {};
    await handler(req, res, body, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : err.message });
  }
});

// Local-only demo login (demo / demo) to try the app without signing up. Never created in production, where a known
// password would be an open door.
if (!PROD && !get("SELECT 1 AS x FROM users WHERE email = 'demo'")) {
  const now = new Date().toISOString();
  run('INSERT INTO users (id, email, password_hash, created_at, age_confirmed_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), 'demo', await hashPassword('demo'), now, now, now]);
}

// Photos expire at the end of each user's local day; sweep every minute so none outlives it by more than that.
housekeeping();
setInterval(housekeeping, 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Maia running at http://localhost:${PORT}${PROD ? ' (production)' : ''}`);
  if (DEV_LINKS) console.log('Email: not configured (set RESEND_API_KEY). Confirmation links are shown in the app instead.');
  if (!PROD) console.log('Demo login: demo / demo');
  console.log(process.env.ANTHROPIC_API_KEY ? 'AI mode: live Claude calls' : 'AI mode: fallback heuristics (set ANTHROPIC_API_KEY for real generation)');
});
