import crypto from 'node:crypto';
import { run, get } from './db.js';
import { PROD } from './env.js';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const PRICE_IDS = { monthly: process.env.STRIPE_PRICE_MONTHLY, annual: process.env.STRIPE_PRICE_ANNUAL };

// Display prices only. What is actually charged lives in Stripe / App Store Connect / Play Console.
export const PLANS = [
  { id: 'monthly', label: 'Monthly', price: '$14.99', period: 'month' },
  { id: 'annual', label: 'Annual', price: '$119.99', period: 'year', note: 'Save 33%' },
];

export const stripeEnabled = () => !!STRIPE_SECRET_KEY;

// Single write path for premium access, shared by Stripe, RevenueCat (App Store / Play) and the dev mock.
// Access is stored per payment channel and the user gets the longest one, so ending one channel (e.g. cancelling
// Stripe) never cuts access another channel is still paying for.
export function setEntitlement(userId, { plan, premiumUntil, source, stripeCustomerId = null }) {
  if (!get('SELECT 1 AS x FROM users WHERE id = ?', [userId])) return;
  run(`INSERT INTO entitlements (user_id, source, plan, premium_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, source) DO UPDATE SET plan = excluded.plan, premium_until = excluded.premium_until`,
  [userId, source, plan, new Date(premiumUntil).toISOString()]);
  const best = get('SELECT source, plan, premium_until FROM entitlements WHERE user_id = ? ORDER BY premium_until DESC LIMIT 1', [userId]);
  run('UPDATE users SET plan = ?, premium_until = ?, billing_source = ?, stripe_customer_id = COALESCE(?, stripe_customer_id) WHERE id = ?',
    [best.plan, best.premium_until, best.source, stripeCustomerId, userId]);
}

async function stripe(path, params = null, method = 'POST') {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${STRIPE_SECRET_KEY}`, ...(params && { 'content-type': 'application/x-www-form-urlencoded' }) },
    body: params ? new URLSearchParams(params) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe: ${data.error?.message || res.status}`);
  return data;
}

const LIVE_STATUSES = ['active', 'trialing', 'past_due'];
const periodEndOf = (s) => s.current_period_end ?? s.items?.data?.[0]?.current_period_end;

async function customerSubscriptions(customerId) {
  return (await stripe(`subscriptions?customer=${encodeURIComponent(customerId)}&status=all&limit=100`, null, 'GET')).data || [];
}

// Deleting a Maia account must stop web billing too, or Stripe keeps charging a user who no longer exists.
export async function cancelStripeSubscriptions(customerId) {
  for (const s of await customerSubscriptions(customerId)) {
    if (!['canceled', 'incomplete_expired'].includes(s.status)) await stripe(`subscriptions/${s.id}`, null, 'DELETE');
  }
}

export async function createCheckout(user, plan, appUrl) {
  const session = await stripe('checkout/sessions', {
    mode: 'subscription',
    'line_items[0][price]': PRICE_IDS[plan],
    'line_items[0][quantity]': '1',
    client_reference_id: user.id,
    'subscription_data[metadata][user_id]': user.id,
    success_url: `${appUrl}/#/premium?status=success`,
    cancel_url: `${appUrl}/#/premium`,
    ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : { customer_email: user.email }),
  });
  return session.url;
}

export async function createPortal(user, appUrl) {
  const session = await stripe('billing_portal/sessions', { customer: user.stripe_customer_id, return_url: `${appUrl}/#/account` });
  return session.url;
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.rawBody">. Old timestamps are rejected to stop replays.
export function verifyStripeSignature(raw, header, now = Date.now()) {
  if (!header || !STRIPE_WEBHOOK_SECRET) return false;
  const pairs = header.split(',').map((kv) => kv.split('='));
  const t = Number(pairs.find(([k]) => k === 't')?.[1]);
  const sigs = pairs.filter(([k]) => k === 'v1').map(([, v]) => Buffer.from(v || '', 'hex'));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(Buffer.concat([Buffer.from(`${t}.`), raw])).digest();
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(s, expected));
}

/* ---------- App Store / Google Play via RevenueCat ---------- */

const RC_WEBHOOK_AUTH = process.env.REVENUECAT_WEBHOOK_AUTH;
const RC_SECRET_KEY = process.env.REVENUECAT_SECRET_KEY;
const RC_ENTITLEMENT = process.env.REVENUECAT_ENTITLEMENT || 'premium';
const STORE_SOURCE = { APP_STORE: 'app_store', MAC_APP_STORE: 'app_store', PLAY_STORE: 'play_store', app_store: 'app_store', play_store: 'play_store' };
const planForProduct = (id) => (/annual|year/i.test(id || '') ? 'annual' : 'monthly');

export const revenueCatEnabled = () => !!RC_SECRET_KEY;

// RevenueCat sends back, verbatim, the Authorization value configured in its dashboard.
export function verifyRevenueCatAuth(header) {
  if (!RC_WEBHOOK_AUTH || !header) return false;
  const a = Buffer.from(header); const b = Buffer.from(RC_WEBHOOK_AUTH);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const GRANTS = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE', 'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT']);

// Store access ends here: the subscription moved to another Maia account ("Restore purchases" on a second login), or
// RevenueCat no longer lists one. Otherwise one subscription could unlock any number of accounts, each with an AI budget.
function expireStoreAccess(userId) {
  for (const source of ['app_store', 'play_store']) {
    const row = get('SELECT plan FROM entitlements WHERE user_id = ? AND source = ?', [userId, source]);
    if (row) setEntitlement(userId, { plan: row.plan, premiumUntil: Date.now(), source });
  }
}

// CANCELLATION / BILLING_ISSUE keep access until expiry, so only grants, EXPIRATION and TRANSFER change the entitlement.
// TestFlight and Play test purchases are free, so in production a sandbox event never grants real Premium.
export async function applyRevenueCatEvent(e = {}) {
  if (PROD && e.environment === 'SANDBOX') return;
  if (e.type === 'TRANSFER') {
    (e.transferred_from || []).forEach(expireStoreAccess);
    // The receiving account gets its access straight from RevenueCat instead of waiting for the app's own sync.
    if (!revenueCatEnabled()) return;
    const to = (e.transferred_to || []).filter((id) => get('SELECT 1 AS x FROM users WHERE id = ?', [id]));
    await Promise.all(to.map((id) => syncRevenueCat(id).catch((err) => console.error('[billing] transfer sync:', err.message))));
    return;
  }
  if (!get('SELECT id FROM users WHERE id = ?', [e.app_user_id || ''])) return;
  let premiumUntil;
  if (e.type === 'EXPIRATION') premiumUntil = new Date().toISOString();
  else if (GRANTS.has(e.type) && e.expiration_at_ms) premiumUntil = new Date(e.expiration_at_ms).toISOString();
  else return;
  setEntitlement(e.app_user_id, { plan: planForProduct(e.product_id), premiumUntil, source: STORE_SOURCE[e.store] || 'app_store' });
}

// Pull the source of truth from RevenueCat: covers "Restore purchases" and webhook delays.
export async function syncRevenueCat(userId) {
  const res = await fetch(`https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(userId)}`, {
    headers: { authorization: `Bearer ${RC_SECRET_KEY}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`RevenueCat ${res.status}`);
  const { subscriber } = await res.json();
  const ent = subscriber?.entitlements?.[RC_ENTITLEMENT];
  const sub = ent && subscriber.subscriptions?.[ent.product_identifier];
  if (!ent || (PROD && sub?.is_sandbox)) return expireStoreAccess(userId);
  setEntitlement(userId, {
    plan: planForProduct(ent.product_identifier),
    premiumUntil: ent.expires_date || new Date(Date.now() + 100 * 365 * 86400000).toISOString(),
    source: STORE_SOURCE[sub?.store] || 'app_store',
  });
}

export async function applyStripeEvent(event) {
  const obj = event.data?.object || {};
  if (event.type === 'checkout.session.completed') {
    if (obj.client_reference_id && obj.customer) run('UPDATE users SET stripe_customer_id = ? WHERE id = ?', [obj.customer, obj.client_reference_id]);
    return;
  }
  if (!event.type?.startsWith('customer.subscription.')) return;
  // Stripe doesn't guarantee event order, and a customer can have an old cancelled subscription next to a new one.
  // With API access, derive web access from all of the customer's subscriptions, not from this event's snapshot.
  const subs = STRIPE_SECRET_KEY && obj.customer ? await customerSubscriptions(obj.customer) : [obj];
  const best = subs.filter((s) => LIVE_STATUSES.includes(s.status)).sort((a, b) => (periodEndOf(b) || 0) - (periodEndOf(a) || 0))[0];
  const userId = obj.metadata?.user_id || best?.metadata?.user_id || get('SELECT id FROM users WHERE stripe_customer_id = ?', [obj.customer])?.id;
  if (!userId) return;
  setEntitlement(userId, {
    plan: (best || obj).items?.data?.[0]?.price?.id === PRICE_IDS.annual ? 'annual' : 'monthly',
    premiumUntil: new Date(best && periodEndOf(best) ? periodEndOf(best) * 1000 : Date.now()).toISOString(),
    source: 'stripe',
    stripeCustomerId: obj.customer,
  });
}
