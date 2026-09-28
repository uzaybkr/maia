import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const dbFile = path.join(os.tmpdir(), `maia-test-${stamp}.db`);
const photoDbFile = path.join(os.tmpdir(), `maia-test-photos-${stamp}.db`);
Object.assign(process.env, { MAIA_DB: dbFile, MAIA_PHOTO_DB: photoDbFile, MAIA_PHOTO_KEY: crypto.randomBytes(32).toString('hex') });

/* ---------- pure unit checks ---------- */

const { normalizeRitual, normalizeExamination, examinePhoto, generateRitual, generateChatReply } = await import('./lib/ai.js');
const { endOfLocalDay } = await import('./lib/photos.js');

const norm = normalizeRitual({ morning: 'nope', evening: [{ title: '<b>x</b>', detail: 7 }], shopping: [{ item: 'a', tier: 'weird' }] });
assert.deepEqual(norm.morning, [], 'non-array list coerced');
assert.deepEqual(norm.evening, [{ title: '<b>x</b>', detail: '7' }], 'fields coerced to strings');
assert.equal(norm.shopping[0].tier, 'now', 'unknown tier coerced');
assert.throws(() => normalizeRitual({ summary: 'empty' }), 'ritual with no steps rejected');

const exam = normalizeExamination('skin', { metrics: { hydration: 14, evenness: '6.26', bogus: 3 }, summary: 'ok' });
assert.equal(exam.metrics.hydration, 10, 'scores clamped to 0-10');
assert.equal(exam.metrics.evenness, 6.3, 'scores rounded');
assert.equal(exam.metrics.bogus, undefined, 'unknown metrics dropped');
assert.throws(() => normalizeExamination('skin', { metrics: {} }), 'examination without scores rejected');

// Cost routing: only a new ritual goes to the big model, and a truncated/refused reply is a failure, never a score.
{
  const sent = [];
  let stop = 'end_turn';
  const reply = '{"metrics":{"hydration":7},"summary":"ok","morning":[{"title":"a","detail":"b"}]}';
  const saved = { fetch: globalThis.fetch, log: console.log, error: console.error };
  process.env.ANTHROPIC_API_KEY = 'test';
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: reply }] }));
  };
  console.log = console.error = () => {};
  try {
    const img = 'data:image/png;base64,iVBORw0KGgo=';
    assert.equal((await examinePhoto('skin', img)).source, 'ai');
    assert.equal((await generateRitual({ goals: ['Glow'] })).source, 'ai');
    assert.equal((await generateRitual({ goals: ['Glow'] }, { action: 'simplify', current: {} })).source, 'ai');
    assert.equal((await generateChatReply({}, null, [], 'hi')).source, 'ai');
    assert.deepEqual(sent.map((b) => b.model), ['claude-sonnet-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5'], 'models per task');
    assert.ok(sent.every((b) => b.max_tokens >= 16000), 'room for thinking plus the answer');
    stop = 'max_tokens';
    assert.equal((await examinePhoto('skin', img)).examination, null, 'truncated reply is not stored as a score');
  } finally {
    Object.assign(globalThis, { fetch: saved.fetch });
    Object.assign(console, { log: saved.log, error: saved.error });
    delete process.env.ANTHROPIC_API_KEY;
  }
}

const at = Date.UTC(2026, 0, 1, 19, 0); // 19:00 UTC
assert.equal(endOfLocalDay(-240, at), '2026-01-01T20:00:00.000Z', 'Dubai (UTC+4): deleted at local midnight');
assert.equal(endOfLocalDay(480, at), '2026-01-02T08:00:00.000Z', 'Los Angeles (UTC-8): deleted at local midnight');
assert.equal(endOfLocalDay(-345, at), '2026-01-02T18:15:00.000Z', 'Nepal (UTC+5:45): already Jan 2 locally, deleted at its end');
assert.equal(endOfLocalDay(-840, at), '2026-01-02T10:00:00.000Z', 'Kiribati (UTC+14)');
assert.equal(endOfLocalDay(841, at), '2026-01-02T00:00:00.000Z', 'out-of-range offset falls back to UTC');
assert.equal(endOfLocalDay('garbage', at), '2026-01-02T00:00:00.000Z', 'bad offset falls back to UTC');

// Client helpers are plain functions in public/app.js; pull them out so XSS escaping and comparison logic stay tested.
const appSrc = fs.readFileSync('public/app.js', 'utf8');
const grab = (re) => appSrc.match(re)[0];
const { esc, pickBaseline } = new Function(`${grab(/const localDay = .*\n/)}${grab(/function esc\([\s\S]*?\n}\n/)}${grab(/function pickBaseline\([\s\S]*?\n}\n/)}return { esc, pickBaseline };`)();
assert.equal(esc(`<i onx="a('b')">&`), '&lt;i onx=&quot;a(&#39;b&#39;)&quot;&gt;&amp;', 'esc neutralizes HTML');
const on = (d, h = 12) => ({ id: `${d}/${h}`, created: new Date(2026, 0, d, h).toISOString() });
const exams3 = [on(15), on(15, 9), on(14), on(7)];
assert.equal(pickBaseline(exams3, 'day').id, '14/12', 'same-day exam is not a day baseline');
assert.equal(pickBaseline(exams3, 'week').id, '7/12', 'week baseline is >= 7 days older');
assert.equal(pickBaseline(exams3.slice(0, 3), 'week'), null, 'no week baseline yet');

// Production is detected from an https APP_URL even without NODE_ENV, and refuses to boot without its secrets.
const bootProd = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./lib/env.js')"], {
  env: { ...process.env, APP_URL: 'https://maia.example', NODE_ENV: '', MAIA_PHOTO_KEY: '', RESEND_API_KEY: '', MAIA_PHOTO_DB: '' }, encoding: 'utf8',
});
assert.notEqual(bootProd.status, 0, 'production without secrets refuses to start');
assert.match(bootProd.stderr, /MAIA_PHOTO_KEY.*RESEND_API_KEY.*MAIA_PHOTO_DB/);
const bootBackedUpPhotos = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./lib/env.js')"], {
  env: { ...process.env, APP_URL: 'https://maia.example', MAIA_PHOTO_KEY: 'x', RESEND_API_KEY: 'x', MAIA_DATA_DIR: os.tmpdir(), MAIA_PHOTO_DB: path.join(os.tmpdir(), 'photos.db') },
  encoding: 'utf8',
});
assert.match(bootBackedUpPhotos.stderr, /outside MAIA_DATA_DIR/, 'production refuses a photo DB inside the backed-up data folder');

/* ---------- server ---------- */

const STRIPE_WEBHOOK_SECRET = 'whsec_test';
const RC_AUTH = 'rc_webhook_secret';
const env = {
  ...process.env, PORT: String(PORT), TRUST_PROXY: '1', ANTHROPIC_API_KEY: '', RESEND_API_KEY: '', APP_URL: '', NODE_ENV: '',
  STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY: 'price_m', STRIPE_PRICE_ANNUAL: 'price_a',
  REVENUECAT_WEBHOOK_AUTH: RC_AUTH, REVENUECAT_SECRET_KEY: '',
};

const rcWebhook = (event, auth = RC_AUTH) => fetch(`${BASE}/api/billing/revenuecat-webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify({ event }),
});

function stripeWebhook(event, { secret = STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000), sig } = {}) {
  const raw = JSON.stringify(event);
  const v1 = sig || crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(`${BASE}/api/billing/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` }, body: raw });
}

const server = spawn(process.execPath, ['--no-warnings', 'server.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
let startTimer;
await Promise.race([
  new Promise((resolve) => server.stdout.on('data', () => serverLog.includes('running') && resolve())),
  new Promise((_, reject) => {
    server.on('exit', (c) => reject(new Error(`server exited early (${c}); is port ${PORT} free?`)));
    startTimer = setTimeout(() => reject(new Error('server start timeout')), 10000);
  }),
]).finally(() => clearTimeout(startTimer));

let cookie = '';
async function call(method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
}

function sql(file, mode, q, params = []) {
  const db = new DatabaseSync(file);
  try { return db.prepare(q)[mode](...params); } finally { db.close(); }
}
const peek = (q, p) => sql(dbFile, 'get', q, p);
const poke = (q, p) => sql(dbFile, 'run', q, p);
const peekPhotos = (q, p) => sql(photoDbFile, 'get', q, p);
const pokePhotos = (q, p) => sql(photoDbFile, 'run', q, p);

// The dev server logs links instead of emailing them; poll so the log line and HTTP response can arrive in any order.
async function logToken(kind, email) {
  const re = new RegExp(`${kind} link for ${email}: \\S+token=([a-f0-9]{64})`, 'g');
  for (let i = 0; i < 40; i++) {
    const hit = [...serverLog.matchAll(re)].at(-1)?.[1];
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

try {
  const me = await call('GET', '/api/me');
  assert.equal(me.status, 401);
  assert.match(me.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(me.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await fetch(`${BASE}/healthz`)).status, 200, 'health check for load balancers');

  /* request hygiene */
  assert.equal((await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"email":"a@b.co","password":"x"}' })).status, 415, 'non-JSON POST rejected (login CSRF)');
  assert.equal((await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(5 * 1024 * 1024) })).status, 413, 'oversized body rejected');

  const ADULT = { age_confirmed: true };
  assert.equal((await call('POST', '/api/signup', { email: 'a@b.co', password: 'short', ...ADULT })).status, 400);
  assert.equal((await call('POST', '/api/signup', { email: 'a@b.co', password: 'longenough1' })).status, 400, 'T5: 18+ confirmation required');
  const signedUp = await call('POST', '/api/signup', { email: 'a@b.co', password: 'longenough1', ...ADULT });
  assert.equal(signedUp.status, 200);
  assert.match(signedUp.data.dev_verify_url, /\/verify\?token=[a-f0-9]{64}$/, 'dev without an email service hands the confirm link to the app');
  assert.ok(peek('SELECT age_confirmed_at FROM users').age_confirmed_at, 'T5: age confirmation recorded');
  assert.equal((await call('POST', '/api/signup', { email: 'a@b.co', password: 'longenough1', ...ADULT })).status, 409);
  const sid = cookie.split('=')[1];
  assert.ok(!peek('SELECT id FROM sessions WHERE id = ?', [sid]), 'raw session id not stored');

  const race = await Promise.all([1, 2].map(() => fetch(`${BASE}/api/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '5.5.5.5' }, body: JSON.stringify({ email: 'race@b.co', password: 'longenough1', ...ADULT }),
  })));
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409], 'concurrent duplicate signup is a 409, not a 500');

  /* T6: email verification gates AI features */
  assert.equal((await call('GET', '/api/me')).data.email_verified, false);
  await call('POST', '/api/onboarding', { goals: [{ evil: 1 }, 'y'.repeat(500), 'Clearer skin'] });
  assert.deepEqual((await call('GET', '/api/profile')).data.profile.goals, ['y'.repeat(60), 'Clearer skin'], 'goals are short strings only');
  await call('POST', '/api/onboarding', { goals: ['Clearer skin'], budget: 'Low ($0-40/mo)', climate: 'hot & dry' });
  const blocked = await call('POST', '/api/examinations', { kind: 'skin', photo: PHOTO, consent: true });
  assert.equal(blocked.status, 403, 'unverified users cannot use AI');
  assert.equal(blocked.data.code, 'unverified');
  const token = await logToken('verify', 'a@b.co');
  assert.ok(token, 'dev mode logs the verify link');
  assert.ok(!peek('SELECT token_hash FROM verifications WHERE token_hash = ?', [token]), 'raw token not stored');
  assert.equal((await call('GET', '/verify?token=nope')).headers.get('location'), '/#/verify-failed');
  assert.equal((await call('GET', `/verify?token=${token}`)).headers.get('location'), '/#/verified');
  assert.equal((await call('GET', `/verify?token=${token}`)).headers.get('location'), '/#/verify-failed', 'token is single-use');
  assert.equal((await call('GET', '/api/me')).data.email_verified, true);

  const mainCookie = cookie;
  await call('POST', '/api/signup', { email: 'late@b.co', password: 'longenough1', ...ADULT });
  poke('UPDATE verifications SET expires_at = ? WHERE used_at IS NULL', [new Date(Date.now() - 1000).toISOString()]);
  assert.equal((await call('GET', `/verify?token=${await logToken('verify', 'late@b.co')}`)).headers.get('location'), '/#/verify-failed', 'expired token rejected');
  assert.equal((await call('POST', '/api/verify/resend')).status, 200);
  assert.equal((await call('GET', `/verify?token=${await logToken('verify', 'late@b.co')}`)).headers.get('location'), '/#/verified', 'resent token works');
  cookie = mainCookie;
  assert.equal((await call('GET', '/api/me')).data.onboarding_complete, true);

  /* Free members cost no AI: a starter ritual from their answers; photos, revisions and chat are Premium */
  const userId = peek("SELECT id FROM users WHERE email = 'a@b.co'").id;
  assert.equal((await call('POST', '/api/examinations', { kind: 'skin', photo: PHOTO, consent: true })).status, 402, 'photo analysis is premium');
  const starter = (await call('POST', '/api/ritual/generate')).data;
  assert.equal(starter.source, 'starter');
  assert.ok(starter.ritual.shopping.every((s) => s.tier === 'now'), 'low budget drops upgrades');
  assert.equal((await call('POST', '/api/ritual/revise', { action: 'simplify' })).status, 402, 'free users gated');
  assert.equal((await call('POST', '/api/chat', { message: 'hi' })).status, 402, 'free users gated');
  assert.equal(peek('SELECT COUNT(*) AS n FROM ai_calls').n, 0, 'free members trigger no AI calls');
  assert.equal(peekPhotos('SELECT COUNT(*) AS n FROM photos').n, 0, 'free members store no photos');
  await call('POST', '/api/subscribe');

  /* T1: analyze, keep examination, photo sealed in its own DB until end of local day */
  assert.equal((await call('POST', '/api/examinations', { kind: 'skin', photo: PHOTO, consent: false })).status, 400, 'consent required');
  assert.equal((await call('POST', '/api/examinations', { kind: 'skin', photo: 'javascript:alert(1)', consent: true })).status, 400, 'invalid photo rejected');
  assert.equal((await call('POST', '/api/examinations', { kind: 'nose', photo: PHOTO, consent: true })).status, 400, 'unknown kind rejected');
  const ex = await call('POST', '/api/examinations', { kind: 'skin', photo: PHOTO, consent: true, tzOffset: -240 });
  assert.equal(ex.status, 200);
  assert.equal(typeof ex.data.examination.metrics.hydration, 'number');
  assert.ok(new Date(ex.data.photoExpiresAt) - Date.now() <= 86400000, 'photo expires within 24h');
  const photoRow = peekPhotos('SELECT sealed, consent_at FROM photos');
  assert.match(photoRow.sealed, /^v1:/, 'photo sealed at rest');
  assert.ok(!photoRow.sealed.includes('iVBORw0KGgo'), 'no plaintext photo bytes');
  assert.ok(photoRow.consent_at, 'consent time recorded');
  assert.ok(!fs.readFileSync(dbFile).includes('v1:'), 'main DB (the one that gets backed up) never holds photos');
  assert.ok(!peek('SELECT data FROM profiles').data.includes('photos'), 'profile holds no photos');
  assert.ok(!JSON.stringify((await call('GET', '/api/profile')).data).includes('v1:'), 'API never returns photos');

  const gen = (await call('POST', '/api/ritual/generate')).data;
  assert.equal(gen.source, 'fallback', "premium gets Maia's own ritual (fallback while no AI key is set)");

  pokePhotos('UPDATE photos SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
  await call('POST', '/api/ritual/generate');
  assert.equal(peekPhotos('SELECT COUNT(*) AS n FROM photos').n, 0, 'expired photos purged');
  assert.equal(peek('SELECT COUNT(*) AS n FROM examinations').n, 1, 'examination survives the purge');

  /* T3: examination history for day/week comparison */
  poke('INSERT INTO examinations (id, user_id, kind, metrics, summary, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['old-1', userId, 'skin', '{"hydration":4}', 'last week', 'fallback', new Date(Date.now() - 8 * 86400000).toISOString()]);
  const hist = (await call('GET', '/api/examinations?kind=skin')).data.examinations;
  assert.equal(hist.length, 2);
  assert.equal(hist[1].id, 'old-1', 'newest first');
  assert.equal(hist[1].metrics.hydration, 4, 'metrics parsed');
  assert.equal((await call('GET', '/api/examinations?kind=nose')).status, 400);

  /* rituals + checkins */
  const ritualId = (await call('GET', '/api/ritual/today')).data.id;
  assert.deepEqual((await call('POST', '/api/ritual/checkin', { ritualId, stepKey: 'morning-0', day: '2026-01-01' })).data.progress, ['morning-0']);
  assert.deepEqual((await call('GET', '/api/ritual/today?day=2026-01-01')).data.progress, ['morning-0']);
  assert.deepEqual((await call('GET', '/api/ritual/today?day=2026-01-02')).data.progress, [], 'progress resets each day');
  assert.equal((await call('POST', '/api/ritual/checkin', { ritualId: 'not-mine', stepKey: 'x' })).status, 404);

  // Budget = AI attempts per kind (premium: 3 new rituals a week, 2 used so far); rejected requests don't count.
  assert.equal((await call('POST', '/api/ritual/generate')).status, 200);
  assert.equal((await call('POST', '/api/ritual/generate')).status, 429, 'new rituals have a weekly budget');
  assert.equal((await call('POST', '/api/examinations', { kind: 'posture', photo: PHOTO, consent: true })).status, 200, 'limits are per kind (posture photo)');
  assert.equal(peek('SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ?', [userId]).n, 5, 'only allowed calls are logged');
  await call('POST', '/api/privacy/delete');
  assert.equal((await call('POST', '/api/ritual/generate')).status, 429, 'deleting history does not reset the AI budget');

  /* premium features */
  const rev = (await call('POST', '/api/ritual/revise', { action: 'simplify' })).data;
  assert.equal(rev.ritual.morning.length, 1, 'simplify trims steps');
  assert.equal((await call('GET', '/api/ritual/today')).data.id, rev.id);

  assert.equal((await call('POST', '/api/chat', { message: 'hello' })).status, 200);
  assert.deepEqual((await call('GET', '/api/chat/history')).data.messages.map((m) => m.role), ['user', 'assistant'], 'chat order stable');

  /* T7: premium is an expiring entitlement, not a flag */
  const ent = (await call('GET', '/api/me')).data;
  assert.equal(ent.plan, 'monthly');
  assert.equal(ent.billing_source, 'dev');
  assert.ok(new Date(ent.premium_until) > new Date(), 'entitlement runs into the future');
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'monthly' })).status, 409, 'no second subscription while premium');
  const past = new Date(Date.now() - 1000).toISOString();
  poke('UPDATE entitlements SET premium_until = ? WHERE user_id = ?', [past, userId]);
  poke('UPDATE users SET premium_until = ? WHERE id = ?', [past, userId]);
  assert.equal((await call('POST', '/api/chat', { message: 'still there?' })).status, 402, 'expired entitlement loses premium');
  assert.equal((await call('GET', '/api/me')).data.is_premium, false);

  /* T8/T9: plans + Stripe web billing */
  const plans = (await call('GET', '/api/billing/plans')).data;
  assert.deepEqual(plans.plans.map((p) => p.id), ['monthly', 'annual']);
  assert.equal(plans.stripe, false, 'Stripe reported as not configured without a key');
  assert.equal((await call('POST', '/api/billing/checkout', { plan: 'monthly' })).status, 503, 'checkout needs keys');

  const periodEnd = Math.floor(Date.now() / 1000) + 365 * 86400;
  const subEvent = (type, status = 'active') => ({ type, data: { object: {
    customer: 'cus_123', status, metadata: { user_id: userId },
    items: { data: [{ current_period_end: periodEnd, price: { id: 'price_a' } }] },
  } } });
  assert.equal((await fetch(`${BASE}/api/billing/stripe-webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400, 'unsigned webhook rejected');
  assert.equal((await stripeWebhook(subEvent('customer.subscription.updated'), { secret: 'whsec_forged' })).status, 400, 'forged signature rejected');
  assert.equal((await stripeWebhook(subEvent('customer.subscription.updated'), { t: Math.floor(Date.now() / 1000) - 600 })).status, 400, 'replayed old event rejected');
  assert.equal((await stripeWebhook(subEvent('customer.subscription.updated'))).status, 200);
  const paid = peek('SELECT plan, premium_until, billing_source, stripe_customer_id FROM users WHERE id = ?', [userId]);
  assert.equal(paid.plan, 'annual', 'price id maps to plan');
  assert.equal(paid.billing_source, 'stripe');
  assert.equal(paid.stripe_customer_id, 'cus_123');
  assert.equal(new Date(paid.premium_until).getTime(), periodEnd * 1000, 'access runs to period end');
  await stripeWebhook(subEvent('customer.subscription.deleted', 'canceled'));
  assert.equal((await call('GET', '/api/me')).data.is_premium, false, 'cancelled subscription ends access');

  // checkout.session.completed links the Stripe customer; later events without metadata resolve through it; past_due keeps access.
  await stripeWebhook({ type: 'checkout.session.completed', data: { object: { client_reference_id: userId, customer: 'cus_9' } } });
  assert.equal(peek('SELECT stripe_customer_id FROM users WHERE id = ?', [userId]).stripe_customer_id, 'cus_9');
  const noMeta = subEvent('customer.subscription.updated', 'past_due');
  delete noMeta.data.object.metadata;
  noMeta.data.object.customer = 'cus_9';
  await stripeWebhook(noMeta);
  assert.equal((await call('GET', '/api/me')).data.is_premium, true, 'customer-id lookup + past_due keeps access');
  await stripeWebhook({ ...noMeta, type: 'customer.subscription.deleted', data: { object: { ...noMeta.data.object, status: 'canceled' } } });

  /* T12: App Store / Play purchases via RevenueCat webhook */
  assert.equal((await call('GET', '/api/me')).data.id, userId, 'client knows its id for RevenueCat appUserID');
  const expMs = Date.now() + 30 * 86400000;
  const rcEvent = (type, extra = {}) => ({ type, app_user_id: userId, product_id: 'maia_annual', store: 'PLAY_STORE', expiration_at_ms: expMs, ...extra });
  assert.equal((await rcWebhook(rcEvent('INITIAL_PURCHASE'), 'wrong')).status, 401, 'webhook needs the shared secret');
  assert.equal((await rcWebhook(rcEvent('INITIAL_PURCHASE'))).status, 200);
  const iap = peek('SELECT plan, premium_until, billing_source FROM users WHERE id = ?', [userId]);
  assert.deepEqual([iap.plan, iap.billing_source, new Date(iap.premium_until).getTime()], ['annual', 'play_store', expMs]);
  await rcWebhook(rcEvent('CANCELLATION'));
  assert.equal((await call('GET', '/api/me')).data.is_premium, true, 'cancelling keeps access until expiry');
  await rcWebhook(rcEvent('EXPIRATION'));
  assert.equal((await call('GET', '/api/me')).data.is_premium, false, 'expiration ends access');
  assert.equal((await rcWebhook(rcEvent('INITIAL_PURCHASE', { app_user_id: 'someone-else' }))).status, 200, 'unknown users ignored');
  assert.equal((await call('POST', '/api/billing/revenuecat-sync')).status, 503, 'sync needs the RevenueCat secret key');

  /* access is per payment channel: ending one never cuts another that is still paid */
  await stripeWebhook(subEvent('customer.subscription.updated'));
  await rcWebhook(rcEvent('EXPIRATION'));
  assert.equal((await call('GET', '/api/me')).data.is_premium, true, 'store expiry cannot revoke a live Stripe subscription');
  await rcWebhook(rcEvent('INITIAL_PURCHASE'));
  assert.equal(new Date(peek('SELECT premium_until FROM users WHERE id = ?', [userId]).premium_until).getTime(), periodEnd * 1000, 'the longest channel wins');
  await stripeWebhook(subEvent('customer.subscription.deleted', 'canceled'));
  const afterStripe = (await call('GET', '/api/me')).data;
  assert.deepEqual([afterStripe.is_premium, afterStripe.billing_source], [true, 'play_store'], 'cancelling Stripe keeps the still-paid Play subscription');
  await call('POST', '/api/subscribe');

  /* privacy delete */
  await call('POST', '/api/examinations', { kind: 'hair', photo: PHOTO, consent: true });
  await call('POST', '/api/privacy/delete');
  assert.equal((await call('GET', '/api/chat/history')).data.messages.length, 0);
  assert.equal(peekPhotos('SELECT COUNT(*) AS n FROM photos').n, 0, 'privacy delete removes photos');
  assert.equal(peek('SELECT COUNT(*) AS n FROM examinations').n, 0, 'privacy delete removes examinations');

  assert.notEqual((await fetch(`${BASE}/%2e%2e/server.js`)).status, 200, 'no path traversal');

  /* T10: native apps use bearer tokens + CORS for the Capacitor origins only */
  const nativeHeaders = { 'content-type': 'application/json', 'x-maia-client': 'native', origin: 'capacitor://localhost', 'x-forwarded-for': '6.6.6.6' };
  const nSignup = await fetch(`${BASE}/api/signup`, { method: 'POST', headers: nativeHeaders, body: JSON.stringify({ email: 'n@b.co', password: 'longenough1', ...ADULT }) });
  const nToken = (await nSignup.json()).token;
  assert.match(nToken || '', /^[a-f0-9]{64}$/, 'native signup returns a bearer token');
  assert.equal(nSignup.headers.get('access-control-allow-origin'), 'capacitor://localhost');
  const bearer = { authorization: `Bearer ${nToken}`, origin: 'https://localhost' };
  assert.equal((await fetch(`${BASE}/api/me`, { headers: bearer })).status, 200, 'bearer auth works without cookies');
  const pre = await fetch(`${BASE}/api/me`, { method: 'OPTIONS', headers: { origin: 'capacitor://localhost', 'access-control-request-headers': 'authorization' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  assert.equal((await fetch(`${BASE}/api/me`, { headers: { origin: 'capacitor://localhost' } })).headers.get('access-control-allow-origin'), 'capacitor://localhost', 'CORS headers on error responses too');
  assert.equal((await fetch(`${BASE}/api/me`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null, 'foreign origins get no CORS');
  const webSignup = await fetch(`${BASE}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6' }, body: JSON.stringify({ email: 'w@b.co', password: 'longenough1', ...ADULT }) });
  assert.equal((await webSignup.json()).token, undefined, 'web clients never see the token in the body');
  await fetch(`${BASE}/api/logout`, { method: 'POST', headers: bearer });
  assert.equal((await fetch(`${BASE}/api/me`, { headers: bearer })).status, 401, 'bearer logout revokes the token');

  /* password reset */
  const oldCookie = cookie;
  assert.equal((await call('POST', '/api/password/forgot', { email: 'a@b.co' })).status, 200);
  assert.equal((await call('POST', '/api/password/forgot', { email: 'nobody@b.co' })).status, 200, 'forgot does not reveal which emails exist');
  const resetToken = await logToken('reset', 'a@b.co');
  assert.ok(resetToken, 'dev mode logs the reset link');
  await call('POST', '/api/password/forgot', { email: 'a@b.co' }); // e.g. a stranger re-requesting for this address
  let laterToken = resetToken;
  for (let i = 0; i < 40 && laterToken === resetToken; i++) laterToken = await logToken('reset', 'a@b.co');
  assert.equal((await call('POST', '/api/password/reset', { token: 'nope', password: 'newpassword1' })).status, 400);
  assert.equal((await call('POST', '/api/password/reset', { token: resetToken, password: 'short' })).status, 400);
  assert.equal((await call('POST', '/api/password/reset', { token: resetToken, password: 'newpassword1' })).status, 200, 'a later request does not invalidate the first link');
  assert.equal((await call('POST', '/api/password/reset', { token: resetToken, password: 'newpassword2' })).status, 400, 'reset token is single-use');
  assert.notEqual(laterToken, resetToken);
  assert.equal((await call('POST', '/api/password/reset', { token: laterToken, password: 'newpassword2' })).status, 400, 'other outstanding reset links die after a reset');
  cookie = oldCookie;
  assert.equal((await call('GET', '/api/me')).status, 401, 'reset logs out every session');
  assert.equal((await call('POST', '/api/login', { email: 'a@b.co', password: 'longenough1' }, { 'x-forwarded-for': '7.7.7.1' })).status, 401, 'old password stops working');
  assert.equal((await call('POST', '/api/login', { email: 'a@b.co', password: 'newpassword1' }, { 'x-forwarded-for': '7.7.7.1' })).status, 200);

  /* billing internals with the provider APIs stubbed (runs in this process, no network) */
  Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk_test_stub', REVENUECAT_SECRET_KEY: 'rc_sk_stub' });
  const billing = await import('./lib/billing.js');
  const realFetch = globalThis.fetch;
  const stubbed = async (routes, fn) => {
    const seen = [];
    globalThis.fetch = async (url, opts = {}) => {
      seen.push(`${opts.method || 'GET'} ${url}`);
      const hit = Object.entries(routes).find(([k]) => `${opts.method || 'GET'} ${url}`.includes(k));
      return Response.json(hit ? hit[1] : {});
    };
    try { await fn(); } finally { globalThis.fetch = realFetch; }
    return seen;
  };
  poke("INSERT INTO users (id, email, password_hash, created_at, stripe_customer_id) VALUES ('u-ip', 'ip@b.co', 'x', 'x', 'cus_ip')");
  const pe = Math.floor(Date.now() / 1000) + 30 * 86400;
  const liveSub = { id: 'sub_1', status: 'active', customer: 'cus_ip', metadata: { user_id: 'u-ip' }, items: { data: [{ current_period_end: pe, price: { id: 'price_a' } }] } };
  const oldCancelled = { ...liveSub, id: 'sub_0', status: 'canceled' };
  await stubbed({ 'GET https://api.stripe.com/v1/subscriptions?': { data: [oldCancelled, liveSub] } }, () => billing.applyStripeEvent({
    type: 'customer.subscription.created', data: { object: { ...liveSub, status: 'incomplete' } },
  }));
  assert.equal(new Date(peek("SELECT premium_until FROM users WHERE id = 'u-ip'").premium_until).getTime(), pe * 1000, 'stale/out-of-order Stripe event resolved from live subscriptions');
  await stubbed({ 'GET https://api.stripe.com/v1/subscriptions?': { data: [oldCancelled, liveSub] } }, () => billing.applyStripeEvent({
    type: 'customer.subscription.deleted', data: { object: oldCancelled },
  }));
  assert.ok(peek("SELECT premium_until FROM users WHERE id = 'u-ip'").premium_until > new Date().toISOString(), 'a retried delete of an old subscription does not cancel the new one');

  const calls = await stubbed({ 'GET https://api.stripe.com/v1/subscriptions?': { data: [{ id: 'sub_1', status: 'active' }] } }, () => billing.cancelStripeSubscriptions('cus_ip'));
  assert.ok(calls.includes('DELETE https://api.stripe.com/v1/subscriptions/sub_1'), 'account deletion cancels live Stripe subscriptions');

  await stubbed({ 'https://api.revenuecat.com/v1/subscribers/u-ip': { subscriber: {
    entitlements: { premium: { product_identifier: 'maia_annual', expires_date: '2031-01-01T00:00:00Z' } },
    subscriptions: { maia_annual: { store: 'app_store' } },
  } } }, () => billing.syncRevenueCat('u-ip'));
  assert.deepEqual({ ...peek("SELECT plan, billing_source FROM users WHERE id = 'u-ip'") }, { plan: 'annual', billing_source: 'app_store' }, 'RevenueCat sync applies store entitlement');

  /* account delete */
  assert.equal((await call('POST', '/api/account/delete')).status, 200);
  assert.equal(peek('SELECT COUNT(*) AS n FROM users WHERE id = ?', [userId]).n, 0, 'user wiped on account delete');
  for (const t of ['sessions', 'profiles', 'rituals', 'checkins', 'messages', 'examinations', 'verifications', 'entitlements', 'ai_calls']) {
    assert.equal(peek(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`, [userId]).n, 0, `${t} wiped on account delete`);
  }
  assert.equal(peekPhotos('SELECT COUNT(*) AS n FROM photos WHERE user_id = ?', [userId]).n, 0, 'photos wiped on account delete');

  /* brute force: spoofed X-Forwarded-For can't dodge limits, and one email can't be hammered from many IPs */
  let spoofLimited = false;
  for (let i = 0; i < 12; i++) spoofLimited ||= (await call('POST', '/api/login', { email: 'x@y.co', password: 'nopenope1' }, { 'x-forwarded-for': `${i}.1.1.1, 8.8.8.8` })).status === 429;
  assert.ok(spoofLimited, 'rate limit keys on the proxy-appended (rightmost) address');
  let emailLimited = false;
  for (let i = 0; i < 22; i++) emailLimited ||= (await call('POST', '/api/login', { email: 'victim@y.co', password: 'nopenope1' }, { 'x-forwarded-for': `9.9.9.${i}` })).status === 429;
  assert.ok(emailLimited, 'per-email limit on failed logins across many IPs');

  console.log('All smoke checks passed');
} finally {
  server.kill();
  await new Promise((r) => (server.exitCode !== null ? r() : server.on('exit', r)));
  (await import('./lib/db.js')).db.close();
  (await import('./lib/photos.js')).photoDb.close();
  for (const f of [dbFile, photoDbFile]) for (const s of ['', '-journal']) fs.rmSync(f + s, { force: true });
}
