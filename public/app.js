const app = document.getElementById('app');
const state = { user: null, ritual: null, ritualId: null, progress: [], source: null };

const CONFIG = window.MAIA_CONFIG || {};
const NATIVE = !!window.Capacitor?.isNativePlatform?.();
const PLATFORM = window.Capacitor?.getPlatform?.() || 'web';

// Turkish when the phone is set to Turkish (or chosen under Profile → Language), English otherwise. Translations live
// in i18n.js keyed by the English text, so anything untranslated simply shows in English.
const LANG = prefGet('maia.lang') || (/^tr\b/i.test(navigator.language || '') ? 'tr' : 'en');
const LOCALE = LANG === 'tr' ? 'tr-TR' : undefined;
document.documentElement.lang = LANG;
function t(text, vars = {}) {
  const s = (LANG === 'tr' && window.MAIA_TR?.[text]) || text;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
function setLang(lang) {
  prefSet('maia.lang', lang);
  location.reload(); // the router tells the server on the next load, so Maia writes in this language too
}

// ponytail: native session token lives in WebView localStorage (app-sandboxed). Move to Keychain/Keystore
// via a secure-storage plugin before handling anything more sensitive than a revocable session id.
async function api(method, url, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (NATIVE) {
    headers['x-maia-client'] = 'native';
    const token = prefGet('maia.token');
    if (token) headers.authorization = `Bearer ${token}`;
  }
  const res = await fetch((NATIVE ? CONFIG.apiBase : '') + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(t(data.error || res.statusText)), { status: res.status, data });
  if (data.token) prefSet('maia.token', data.token);
  return data;
}

const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nav(hash) {
  if (location.hash === hash) return render();
  location.hash = hash;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function prefGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function prefSet(key, v) { try { localStorage.setItem(key, v); } catch { /* storage blocked */ } }

/* ---------- Visual vocabulary ---------- */

const ICONS = {
  check: '<polyline points="20 6 9 17 4 12"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  chev: '<polyline points="9 18 15 12 9 6"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
  wave: '<path d="M3 8c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/><path d="M3 13c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/><path d="M3 18c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/>',
  posture: '<circle cx="12" cy="4.5" r="2"/><path d="M12 7v7M12 14l-3 7M12 14l3 7M7 10h10"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  leaf: '<path d="M11 20A7 7 0 019.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.2-6"/>',
  repeat: '<path d="M20 11a8 8 0 10-2.3 5.7"/><polyline points="20 4 20 11 13 11"/>',
  star: '<polygon points="12 3 14.8 8.7 21 9.6 16.5 14 17.6 20.2 12 17.3 6.4 20.2 7.5 14 3 9.6 9.2 8.7 12 3"/>',
  drop: '<path d="M12 2.7l5.7 5.6a8 8 0 11-11.4 0z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  trend: '<polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/>',
  bag: '<path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/>',
  chat: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
  user: '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  up: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  gem: '<polygon points="6 3 18 3 22 9 12 21 2 9"/><line x1="2" y1="9" x2="22" y2="9"/>',
  bell: '<path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 01-3.4 0"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M9 6V4h6v2"/>',
  doc: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  out: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  camera: '<path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22 6 12 13 2 6"/>',
  simplify: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  swap: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/>',
  tag: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L2 12V2h10l8.6 8.6a2 2 0 010 2.8z"/><path d="M7 7h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
};
const icon = (name, size = 20) => `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

const MAIA_FULL = '/assets/maia.jpg';
const MAIA_FACE = '/assets/maia-face.jpg';
const arch = (size = '', halo = false) => `<div class="arch-wrap">${halo ? '<div class="halo"></div>' : ''}<div class="arch ${size}"><img src="${MAIA_FULL}" alt="Maia" width="900" height="900"${size === 'lg' ? ' fetchpriority="high"' : ''}></div></div>`;
const portrait = (size = '') => `<span class="avatar ${size}"><img src="${MAIA_FACE}" alt="Maia" width="320" height="320"></span>`;
const maiaSays = (text) => `<div class="maia-says">${portrait('sm')}<p>${esc(text)}</p></div>`;

function ring(pct) {
  const r = 34;
  const c = 2 * Math.PI * r;
  return `<div class="ring-wrap"><svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle class="track" cx="40" cy="40" r="${r}"/><circle class="fill" cx="40" cy="40" r="${r}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct / 100)).toFixed(1)}"/></svg><div class="ring-label">${fmtPct(pct)}</div></div>`;
}

let toastTimer;
function toast(message) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('<div class="toast" role="status" aria-live="polite"></div>'); document.body.appendChild(t); }
  t.textContent = message;
  clearTimeout(toastTimer);
  // Start the hide timer once it's actually shown: a frame can be delayed (app in background), leaving it stuck.
  requestAnimationFrame(() => {
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
  });
}

const TABS = [['#/home', 'Ritual', 'sparkle'], ['#/progress', 'Progress', 'trend'], ['#/shopping', 'Shop', 'bag'], ['#/chat', 'Maia', 'chat'], ['#/account', 'You', 'user']];

// Real links, so the router's hashchange does the navigation and Cmd/middle-click and link semantics work.
function tabbar(active) {
  const bar = el(`<nav class="tabbar" aria-label="${t('Main')}"></nav>`);
  for (const [hash, label, ic] of TABS) {
    bar.appendChild(el(`<a href="${hash}" ${hash === active ? 'aria-current="page"' : ''}>${icon(ic, 22)}<span>${t(label)}</span></a>`));
  }
  return bar;
}

// Mounts one screen. `noir` stages it on the espresso backdrop (arrival, composing, premium).
// Re-rendering the same screen (ticking a step, switching a tab inside it) keeps scroll and skips the entrance motion.
let mountedKey = '';
function mount(html, { tab, noir = false, bare = false, fill = false } = {}) {
  const key = location.hash + (fill ? ':fill' : '');
  const same = key === mountedKey;
  mountedKey = key;
  const wrap = el(`<main class="screen ${noir ? 'noir' : ''} ${bare || !tab ? 'bare' : ''} ${fill ? 'fill' : ''} ${same ? 'still' : ''}">${html}</main>`);
  const y = window.scrollY;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', noir ? '#2a1f1a' : '#c5d0c2'); // browser bar matches the screen
  app.replaceChildren(...(noir ? [el('<div class="noir-bg"></div>')] : []), wrap);
  if (tab) app.appendChild(tabbar(tab));
  window.scrollTo(0, same ? y : 0);
  return wrap;
}

const fmtDay = (iso) => new Date(iso).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' });
// Numbers in the reader's conventions: Turkish writes "%29" and "7,7".
const fmtPct = (n) => new Intl.NumberFormat(LOCALE, { style: 'percent' }).format(n / 100);
const fmtScore = (n) => new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);

/* ---------- Arrival: sign in, verify, reset ---------- */

function renderAuth() {
  let mode = prefGet('maia.returning') === '1' ? 'login' : 'signup';
  const wrap = mount(`
    <div class="seg mini lang-pick" role="group" aria-label="Language">
      <button type="button" data-lang="tr" aria-pressed="${LANG === 'tr'}">Türkçe</button>
      <button type="button" data-lang="en" aria-pressed="${LANG === 'en'}">English</button>
    </div>
    <section class="hero">
      ${arch('sm', true)}
      <div class="eyebrow">${t('Maia · Self-care concierge')}</div>
      <h1 class="display">${t('A calmer ritual, <em>made for you.</em>')}</h1>
      <p class="lede">${t('Your goals, preferences and photos, composed into one quiet daily ritual.')}</p>
    </section>
    <div class="seg" role="group" aria-label="${t('Account')}">
      <button type="button" data-mode="login">${t('Log in')}</button>
      <button type="button" data-mode="signup">${t('Create account')}</button>
    </div>
    <form class="glass stack" id="authForm" novalidate>
      <label class="field"><span>${t('Email')}</span><input class="input" type="email" id="email" name="email" autocomplete="email" spellcheck="false" autocapitalize="off" aria-describedby="err" placeholder="${t('you@example.com')}"></label>
      <label class="field"><span>${t('Password')}</span><input class="input" type="password" id="password" name="password" aria-describedby="err" placeholder="${t('At least 8 characters')}"></label>
      <div class="stack" id="signupExtras">
        <label class="check"><input type="checkbox" id="age"><span class="box">${icon('check', 14)}</span><span>${t('I confirm I am 18 or older')}</span></label>
        <p class="fine">${t('By creating an account you agree to the <a href="/terms.html">Terms of Use</a> and <a href="/privacy.html">Privacy Policy</a>.')}</p>
      </div>
      <p class="error" id="err" role="alert" hidden></p>
      <button class="btn block" type="submit" id="submitBtn"></button>
      <a class="fine center" href="#/forgot" id="forgotLink">${t('Forgot your password?')}</a>
    </form>
  `, { noir: true });

  const setMode = (m) => {
    mode = m;
    wrap.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    wrap.querySelector('#signupExtras').hidden = m !== 'signup';
    wrap.querySelector('#forgotLink').hidden = m !== 'login';
    wrap.querySelector('#submitBtn').textContent = t(m === 'login' ? 'Log in' : 'Create account');
    wrap.querySelector('#password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  };
  setMode(mode);
  wrap.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  wrap.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => b.dataset.lang !== LANG && setLang(b.dataset.lang)));

  const err = wrap.querySelector('#err');
  wrap.querySelector('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = wrap.querySelector('#submitBtn');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = t(mode === 'login' ? 'Logging in…' : 'Creating account…');
    try {
      const data = await api('POST', mode === 'login' ? '/api/login' : '/api/signup', {
        email: wrap.querySelector('#email').value.trim(),
        password: wrap.querySelector('#password').value,
        age_confirmed: mode === 'signup' ? wrap.querySelector('#age').checked : undefined,
        lang: LANG,
      });
      prefSet('maia.returning', '1');
      state.user = data;
      state.devVerifyUrl = data.dev_verify_url;
      nav(!data.email_verified ? '#/verify' : data.onboarding_complete ? '#/home' : '#/onboarding');
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = t(mode === 'login' ? 'Log in' : 'Create account');
    }
  });
}

function forgetSession() {
  prefSet('maia.token', '');
  state.user = null; state.ritual = null; state.onboard = null;
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  forgetSession();
  nav('#/auth');
}

function renderForgot() {
  const wrap = mount(`
    <button class="icon-btn" id="backBtn" aria-label="${t('Back')}">${icon('back')}</button>
    <section class="hero">
      ${arch('sm')}
      <div class="eyebrow">${t('Account')}</div>
      <h1>${t('Reset your <em>password</em>')}</h1>
      <p class="lede">${t("Enter your email and we’ll send a link to choose a new one.")}</p>
    </section>
    <form class="glass stack" id="form" novalidate>
      <label class="field"><span>${t('Email')}</span><input class="input" type="email" id="email" name="email" autocomplete="email" spellcheck="false" autocapitalize="off" aria-describedby="msg"></label>
      <button class="btn block" type="submit" id="sendBtn">${t('Send reset link')}</button>
      <p class="fine" id="msg" role="status"></p>
    </form>
  `, { noir: true });
  wrap.querySelector('#backBtn').addEventListener('click', () => nav('#/auth'));
  wrap.querySelector('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = wrap.querySelector('#msg');
    const btn = wrap.querySelector('#sendBtn');
    btn.disabled = true;
    btn.textContent = t('Sending…');
    try {
      await api('POST', '/api/password/forgot', { email: wrap.querySelector('#email').value.trim() });
      msg.textContent = t('If an account exists for that email, a reset link is on its way. It expires in one hour.');
    } catch (e2) {
      msg.textContent = e2.message;
    }
    btn.disabled = false;
    btn.textContent = t('Send reset link');
  });
}

function renderReset(token) {
  const wrap = mount(`
    <section class="hero">
      ${arch('sm')}
      <div class="eyebrow">${t('Account')}</div>
      <h1>${t('Choose a new <em>password</em>')}</h1>
      <p class="lede">${t('Saving it signs you out on every device.')}</p>
    </section>
    <form class="glass stack" id="form" novalidate>
      <label class="field"><span>${t('New password')}</span><input class="input" type="password" id="password" name="password" autocomplete="new-password" aria-describedby="err" placeholder="${t('At least 8 characters')}"></label>
      <p class="error" id="err" role="alert" hidden></p>
      <button class="btn block" type="submit" id="saveBtn">${t('Save password')}</button>
    </form>
  `, { noir: true });
  wrap.querySelector('#form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = wrap.querySelector('#err');
    const btn = wrap.querySelector('#saveBtn');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = t('Saving…');
    try {
      await api('POST', '/api/password/reset', { token, password: wrap.querySelector('#password').value });
      forgetSession();
      toast(t('Password updated. Log in with your new password.'));
      nav('#/auth');
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = t('Save password');
    }
  });
}

function renderVerifyEmail(failed) {
  const wrap = mount(`
    <section class="hero">
      ${arch('', true)}
      <div class="eyebrow">${t('One last step')}</div>
      <h1>${t('Check your <em>inbox</em>')}</h1>
      <p class="lede">${t('We sent a confirmation link to <strong>{email}</strong>. Open it on any device, then come back here.', { email: esc(state.user.email) })}</p>
    </section>
    ${failed ? `<p class="error center" role="alert">${t('That link is invalid or has expired. Send yourself a new one below.')}</p>` : ''}
    ${state.devVerifyUrl ? `
      <div class="glass dev-note stack">
        <p class="fine">${t("<strong>Development mode:</strong> email sending isn’t connected yet, so no email was sent. Confirm here instead.")}</p>
        <a class="btn block" href="${esc(state.devVerifyUrl)}">${t('Confirm my email now')}</a>
      </div>` : ''}
    <div class="stack">
      <button class="btn ${state.devVerifyUrl ? 'ghost' : ''} block" id="checkBtn">${t("I’ve confirmed, continue")}</button>
      <button class="btn ghost block" id="resendBtn">${icon('mail', 18)} ${t('Send the email again')}</button>
      <p class="fine center" id="msg" role="status"></p>
      <button class="btn quiet" id="logoutBtn">${t('Use a different account')}</button>
    </div>
  `, { noir: true });
  const msg = wrap.querySelector('#msg');
  wrap.querySelector('#checkBtn').addEventListener('click', async () => {
    state.user = await api('GET', '/api/me');
    if (state.user.email_verified) return nav('#/home');
    msg.textContent = t('Not confirmed yet. Check your inbox and spam folder.');
  });
  wrap.querySelector('#resendBtn').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/api/verify/resend');
      if (data.dev_verify_url) {
        state.devVerifyUrl = data.dev_verify_url;
        return renderVerifyEmail(false);
      }
      msg.textContent = t('Sent. The new link replaces any earlier one.');
    } catch (e) {
      msg.textContent = e.message;
    }
  });
  wrap.querySelector('#logoutBtn').addEventListener('click', logout);
}

/* ---------- Photos: capture, consent, on-device copies ---------- */

async function downscale(file, max = 1024) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

const KINDS = ['skin', 'hair', 'posture'];
const cap = (s) => s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ');
const localDay = (iso) => new Date(iso).toLocaleDateString('en-CA');
const KIND_ICON = { skin: 'sparkle', hair: 'wave', posture: 'posture' };
const KIND_HINT = { skin: 'Soft daylight, bare skin if you can', hair: 'Hair down, natural light', posture: 'Side view, standing naturally, in fitted clothes' };
const kindName = (k) => t(cap(k));

const POLICY_POINTS = `
  <ul>
    <li>${t("Analyzed to create your written examination and today’s ritual")}</li>
    <li>${t('Kept encrypted only until the end of your day, then permanently deleted')}</li>
    <li>${t('Never stored long-term, never in backups, never used to train AI')}</li>
    <li>${t('Want to compare photos over time? Keep a copy on this phone')}</li>
  </ul>
  <p class="fine" style="margin-top:10px">${t('Photos are processed by our AI provider under its own data terms.')}</p>`;
const policyCard = () => `<div class="glass policy"><div class="policy-head">${icon('shield')}<strong>${t('How Maia handles your photos')}</strong></div>${POLICY_POINTS}</div>`;
const policyDetails = () => `<details class="glass policy"><summary>${icon('shield')} ${t('How Maia handles your photos')}</summary>${POLICY_POINTS}</details>`;

// Photos the user chose to keep live only in this device's IndexedDB, tagged by account id so a shared device doesn't mix accounts.
// ponytail: WebView IndexedDB can be evicted under storage pressure on iOS; move to Capacitor Filesystem if users report loss.
const deviceDB = {
  handle: null,
  open() {
    this.handle ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('maia', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { this.handle = null; reject(req.error); };
    });
    return this.handle;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = fn(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  add(kind, dataUrl) {
    return this.run('readwrite', (s) => s.add({ owner: state.user.id, kind, dataUrl, created: new Date().toISOString() }));
  },
  async list(kind) {
    const all = (await this.run('readonly', (s) => s.getAll())) || [];
    return all.filter((p) => p.owner === state.user.id && (!kind || p.kind === kind)).sort((a, b) => b.created.localeCompare(a.created));
  },
  async clearMine() {
    const mine = await this.list();
    await this.run('readwrite', (s) => { mine.forEach((p) => s.delete(p.id)); });
  },
};

// Consent gates the file picker: no consent, no photo.
function photoCapture(kind, photos) {
  const box = el(`
    <div class="capture">
      <div class="capture-head"><span class="ic">${icon(KIND_ICON[kind])}</span><div><strong>${kindName(kind)}</strong><span>${t(KIND_HINT[kind])}</span></div></div>
      <label class="check"><input type="checkbox" class="consent"><span class="box">${icon('check', 14)}</span><span>${t('I agree Maia may analyze this photo and delete it by the end of my day')}</span></label>
      <div class="capture-preview" hidden><img alt="${t('{kind} photo preview', { kind: kindName(kind) })}"><span class="fine">${t('Ready. Deleted from our servers by the end of today.')}</span></div>
      <label class="btn ghost small file-btn is-disabled">${icon('camera', 16)}<span class="file-label">${t('Choose photo')}</span><input type="file" accept="image/*" class="file" disabled></label>
    </div>
  `);
  const consent = box.querySelector('.consent');
  const file = box.querySelector('.file');
  const fileBtn = box.querySelector('.file-btn');
  const preview = box.querySelector('.capture-preview');
  const sync = () => {
    file.disabled = !consent.checked;
    fileBtn.classList.toggle('is-disabled', !consent.checked);
  };
  consent.addEventListener('change', () => {
    sync();
    if (!consent.checked) {
      photos[kind] = null;
      file.value = '';
      preview.hidden = true;
      box.querySelector('.file-label').textContent = t('Choose photo');
    }
  });
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    photos[kind] = await downscale(file.files[0]);
    preview.querySelector('img').src = photos[kind];
    preview.hidden = false;
    box.querySelector('.file-label').textContent = t('Retake');
  });
  sync();
  return box;
}

function keepOnDeviceToggle() {
  const on = prefGet('maia.keepOnDevice') === '1';
  const box = el(`
    <div class="stack">
      <label class="switch-row"><span><strong>${t('Keep a copy on this phone')}</strong><small>${t('For side-by-side comparison. Never uploaded again.')}</small></span><input type="checkbox" class="keep" ${on ? 'checked' : ''}><span class="switch"></span></label>
      <p class="note warn" ${on ? '' : 'hidden'}>${t('Saved only on this device. Anyone with access to it can see them. Delete them anytime in Progress.')}</p>
    </div>
  `);
  box.querySelector('.keep').addEventListener('change', (e) => {
    prefSet('maia.keepOnDevice', e.target.checked ? '1' : '0');
    box.querySelector('.warn').hidden = !e.target.checked;
  });
  return box;
}

async function submitPhotos(photos) {
  const keep = prefGet('maia.keepOnDevice') === '1';
  for (const [kind, photo] of Object.entries(photos)) {
    if (!photo) continue;
    await api('POST', '/api/examinations', { kind, photo, consent: true, tzOffset: new Date().getTimezoneOffset() });
    if (keep) await deviceDB.add(kind, photo);
    photos[kind] = null; // sent: a retry after a later failure must not re-send (and re-bill) this photo
  }
}

/* ---------- Onboarding: welcome + four guided questions ---------- */

const GOALS = [
  ['Clearer skin', 'sparkle'], ['Stronger hair', 'wave'], ['Better posture', 'posture'], ['More energy', 'sun'],
  ['Better sleep', 'moon'], ['Healthier eating', 'leaf'], ['Steadier routine', 'repeat'], ['Confidence', 'star'],
];
const BUDGETS = [
  ['Low ($0-40/mo)', 'Essentials', 'Up to $40 a month'],
  ['Moderate ($40-100/mo)', 'Balanced', '$40 to $100 a month'],
  ['Flexible ($100+/mo)', 'Indulgent', '$100 or more a month'],
];
const CLIMATES = ['Hot & dry', 'Hot & humid', 'Mild', 'Cold & dry', 'Changing seasons'];

function renderOnboarding() {
  const d = (state.onboard ??= {
    step: 0, goals: [], preferences: '', sensitivities: '', budget: BUDGETS[1][0], region: '', climate: '',
    photos: { skin: null, hair: null, posture: null },
  });
  const go = (step) => { d.step = step; renderOnboarding(); };
  const top = (n) => `
    <div class="wizard-top">
      <button class="icon-btn" data-back aria-label="${t('Back')}">${icon('back')}</button>
      <div class="steps" aria-label="${t('Step {n} of 4', { n })}">${[1, 2, 3, 4].map((i) => `<span class="${i <= n ? 'on' : ''}"></span>`).join('')}</div>
    </div>`;

  let wrap;
  if (d.step === 0) {
    wrap = mount(`
      <section class="hero" style="padding-top:18px">
        ${arch('lg', true)}
        <div class="eyebrow">${t('Welcome to Maia')}</div>
        <h1 class="display">${t("Let’s compose your <em>first ritual.</em>")}</h1>
        <p class="lede">${t("Four gentle questions, about three minutes. I’ll take it from there.")}</p>
      </section>
      <button class="btn block" data-next>${t('Begin')}</button>
    `);
  } else if (d.step === 1) {
    wrap = mount(`
      ${top(1)}
      ${maiaSays(t("Choose what you’d like to feel. I’ll shape everything around it."))}
      <h1>${t('What would you like to <em>feel?</em>')}</h1>
      <div class="goal-grid">
        ${GOALS.map(([g, ic]) => `<button type="button" class="goal" data-goal="${esc(g)}" aria-pressed="${d.goals.includes(g)}"><span class="goal-icon">${icon(ic, 18)}</span>${esc(t(g))}</button>`).join('')}
      </div>
      <div class="actions"><button class="btn block" data-next ${d.goals.length ? '' : 'disabled'}>${t('Next: preferences')}</button></div>
    `);
    wrap.querySelectorAll('[data-goal]').forEach((b) => b.addEventListener('click', () => {
      const g = b.dataset.goal;
      d.goals = d.goals.includes(g) ? d.goals.filter((x) => x !== g) : [...d.goals, g];
      b.setAttribute('aria-pressed', String(d.goals.includes(g)));
      wrap.querySelector('[data-next]').disabled = !d.goals.length;
    }));
  } else if (d.step === 2) {
    wrap = mount(`
      ${top(2)}
      ${maiaSays(t('Tell me what you love and what to avoid. Skip anything you like.'))}
      <h1>${t('A little about <em>you</em>')}</h1>
      <div class="glass stack">
        <label class="field"><span>${t('What you love')}</span><textarea class="input" id="preferences" name="preferences" autocomplete="off" placeholder="${t('Light textures, fragrance-free, quick routines…')}">${esc(d.preferences)}</textarea></label>
        <label class="field"><span>${t('What to avoid')}</span><textarea class="input" id="sensitivities" name="sensitivities" autocomplete="off" placeholder="${t('Retinol, strong scents, dairy…')}">${esc(d.sensitivities)}</textarea></label>
      </div>
      <div class="actions"><button class="btn block" data-next>${t('Next: budget & climate')}</button></div>
    `);
    const save = () => { d.preferences = wrap.querySelector('#preferences').value; d.sensitivities = wrap.querySelector('#sensitivities').value; };
    wrap.querySelectorAll('textarea').forEach((t) => t.addEventListener('input', save));
  } else if (d.step === 3) {
    wrap = mount(`
      ${top(3)}
      ${maiaSays(t('So I suggest products that suit your budget, where you live and the air around you.'))}
      <h1>${t('Budget and <em>climate</em>')}</h1>
      <div class="choice-list" role="radiogroup" aria-label="${t('Monthly budget')}">
        ${BUDGETS.map(([v, name, range]) => `<button type="button" class="choice" role="radio" data-budget="${esc(v)}" aria-checked="${d.budget === v}"><span><strong>${t(name)}</strong><small>${t(range)}</small></span><span class="radio"></span></button>`).join('')}
      </div>
      <label class="field"><span>${t('Where you live')}</span><input class="input" id="region" name="region" autocomplete="address-level2" placeholder="${t('Dubai, UAE…')}" value="${esc(d.region)}"></label>
      <div class="field"><span>${t('Your climate')}</span><div class="chips">${CLIMATES.map((c) => `<button type="button" class="chip" data-climate="${esc(c)}" aria-pressed="${d.climate === c}">${esc(t(c))}</button>`).join('')}</div></div>
      <div class="actions"><button class="btn block" data-next>${t('Next: last step')}</button></div>
    `);
    wrap.querySelectorAll('[data-budget]').forEach((b) => b.addEventListener('click', () => {
      d.budget = b.dataset.budget;
      wrap.querySelectorAll('[data-budget]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    }));
    wrap.querySelectorAll('[data-climate]').forEach((b) => b.addEventListener('click', () => {
      d.climate = d.climate === b.dataset.climate ? '' : b.dataset.climate;
      wrap.querySelectorAll('[data-climate]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.climate === d.climate)));
    }));
    wrap.querySelector('#region').addEventListener('input', (e) => { d.region = e.target.value; });
  } else if (!state.user.is_premium) {
    wrap = mount(`
      ${top(4)}
      ${maiaSays(t("I’ll begin with a ritual built from your answers."))}
      <h1>${t('Your starter <em>ritual</em>')}</h1>
      ${premiumInvite()}
      <div class="actions"><button class="btn block" id="composeBtn">${t('Compose my starter ritual')}</button></div>
    `);
    wrap.querySelector('#composeBtn').addEventListener('click', () => { d.photos = {}; compose(d); });
  } else {
    wrap = mount(`
      ${top(4)}
      ${photoStep(d, 'Optional. A photo shows me where to start, and it’s gone from our servers by tonight.')}
      <div class="actions">
        <button class="btn block" id="composeBtn">${t('Compose my ritual')}</button>
        <button class="btn quiet" id="skipBtn">${t('Skip photos for now')}</button>
      </div>
    `);
    wirePhotoStep(wrap, d);
    wrap.querySelector('#composeBtn').addEventListener('click', () => compose(d));
    wrap.querySelector('#skipBtn').addEventListener('click', () => { d.photos = {}; compose(d); });
  }
  wrap.querySelector('[data-next]')?.addEventListener('click', () => go(d.step + 1));
  wrap.querySelector('[data-back]')?.addEventListener('click', () => go(d.step - 1));
}

// The "let me see" photo step, shared by onboarding and by new Premium members composing Maia's ritual later.
const photoStep = (d, intro) => `
  ${maiaSays(t(intro))}
  <h1>${t('Let me <em>see</em>')}</h1>
  ${policyCard()}
  <div class="glass" id="captures"></div>
  <div class="glass" id="keepSlot"></div>`;
function wirePhotoStep(wrap, d) {
  const captures = wrap.querySelector('#captures');
  KINDS.forEach((k) => captures.appendChild(photoCapture(k, d.photos)));
  wrap.querySelector('#keepSlot').appendChild(keepOnDeviceToggle());
}

// What free members see where Premium's photo features would be. Free costs no AI at launch.
const premiumInvite = (button = '') => `
  <section class="glass stack">
    <div class="spread"><strong>${t('Let Maia <em>see</em> you')}</strong><span class="pill">${icon('lock', 12)} Premium</span></div>
    <p class="muted">${t('She reads your skin, hair and posture from photos, writes your ritual personally and tracks the change day by day.')}</p>
    ${button}
  </section>`;

function renderCompose() {
  if (!state.user.is_premium) return nav('#/premium');
  const d = { goals: [], photos: { skin: null, hair: null, posture: null } };
  const wrap = mount(`
    ${photoStep(d, 'Add one photo or all three. It’s gone from our servers by tonight.')}
    <div class="actions"><button class="btn block" id="composeBtn">${t('Compose my ritual')}</button></div>
  `, { tab: '#/home' });
  wirePhotoStep(wrap, d);
  wrap.querySelector('#composeBtn').addEventListener('click', () => {
    if (!Object.values(d.photos).some(Boolean)) return toast(t('Tick the consent box and choose a photo first.'));
    compose(d, false);
  });
}

async function compose(d, onboarding = true) {
  const lines = ['Reading your goals…', 'Balancing your morning and evening…', 'Choosing what matters first…', 'Setting out your ritual…'].map((l) => t(l));
  const wrap = mount(`
    ${arch('lg', true)}
    <div class="eyebrow">${t('Composing your ritual')}</div>
    <p class="line" id="line">${lines[0]}</p>
    <div class="progress-dots">${lines.map((_, i) => `<i class="${i === 0 ? 'on' : ''}"></i>`).join('')}</div>
    <p class="fine">${esc(d.goals.map((g) => t(g)).join(' · '))}</p>
  `, { noir: true, fill: true });
  wrap.classList.add('composing');
  let i = 0;
  const ticker = setInterval(() => {
    i = Math.min(i + 1, lines.length - 1);
    const line = wrap.querySelector('#line');
    line.textContent = lines[i];
    line.style.animation = 'none'; void line.offsetWidth; line.style.animation = '';
    wrap.querySelectorAll('.progress-dots i').forEach((dot, n) => dot.classList.toggle('on', n <= i));
  }, 1400);
  try {
    // A brief, unhurried pause even when the fallback answers instantly: this is a ritual, not a form submit.
    await Promise.all([(async () => {
      if (onboarding) {
        await api('POST', '/api/onboarding', {
          goals: d.goals, preferences: d.preferences, sensitivities: d.sensitivities,
          budget: d.budget, region: d.region, climate: d.climate,
        });
      }
      await submitPhotos(d.photos);
      const data = await api('POST', '/api/ritual/generate');
      state.ritual = data.ritual; state.ritualId = data.id; state.progress = data.progress; state.source = data.source;
    })(), sleep(2600)]);
    state.user.onboarding_complete = true;
    state.onboard = null;
    nav('#/home');
  } catch (e) {
    if (onboarding) {
      d.step = 4;
      renderOnboarding();
    } else {
      renderCompose();
    }
    toast(e.message);
  } finally {
    clearInterval(ticker);
  }
}

/* ---------- Ritual (home) ---------- */

const PREFIX = { morning: 'morning', evening: 'evening', weekly_reset: 'weekly', meal_support: 'meal', movement_support: 'movement' };

function stepRow(it, key) {
  const done = state.progress.includes(key);
  return `<button type="button" class="step ${done ? 'done' : ''}" data-key="${key}" role="checkbox" aria-checked="${done}">
    <span class="step-check">${icon('check', 14)}</span>
    <span><span class="step-title">${esc(it.title)}</span><span class="step-detail">${esc(it.detail)}</span></span>
  </button>`;
}
const stepRows = (list) => (state.ritual[list] || []).map((it, i) => stepRow(it, `${PREFIX[list]}-${i}`)).join('');

async function loadRitualIfNeeded() {
  if (state.ritual) return;
  const data = await api('GET', `/api/ritual/today?day=${today()}`);
  if (data.ritual) {
    state.ritual = data.ritual; state.ritualId = data.id; state.progress = data.progress; state.source = data.source;
  }
}

function totalSteps(ritual) {
  return Object.keys(PREFIX).reduce((n, k) => n + (ritual[k] || []).length, 0);
}

async function renderHome() {
  await loadRitualIfNeeded();
  if (!state.ritual) {
    const data = await api('POST', '/api/ritual/generate');
    state.ritual = data.ritual; state.ritualId = data.id; state.progress = data.progress; state.source = data.source;
  }
  const r = state.ritual;
  const total = totalSteps(r);
  const done = state.progress.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const hour = new Date().getHours();
  const greeting = t(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
  const seg = (state.segment ||= hour < 15 ? 'morning' : 'evening');
  const moments = [['morning', 'Morning', 'sun'], ['evening', 'Evening', 'moon'], ['weekly_reset', 'Weekly', 'leaf']];

  const wrap = mount(`
    <header class="greet">
      <div class="eyebrow">${greeting}</div>
      <h1>${esc(new Date().toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }))}</h1>
    </header>
    <section class="glass maia-note">
      <div class="top">
        <div class="arch xs"><img src="${MAIA_FULL}" alt="Maia" width="900" height="900"></div>
        <div>
          <div class="eyebrow">${t('A note from Maia')}</div>
          <p class="quote">${esc(r.summary)}</p>
          <div class="note-tag">${{ fallback: `<span class="pill" title="${t("Full personalization arrives once Maia’s AI is connected")}">${t('Preview ritual')}</span>`, starter: `<span class="pill">${t('Starter ritual')}</span>` }[state.source] || '<span class="signature">Maia</span>'}</div>
        </div>
      </div>
      <div class="foot">
        ${ring(pct)}
        <div style="flex:1"><strong>${t('{done} of {total}', { done, total })}</strong><span class="muted">${t('steps today')}</span></div>
      </div>
    </section>
    <div class="seg" role="group" aria-label="${t('Ritual moment')}">
      ${moments.map(([k, label, ic]) => `<button type="button" data-seg="${k}" aria-pressed="${seg === k}">${icon(ic, 16)}${t(label)}</button>`).join('')}
    </div>
    <section class="glass steps-list">
      ${stepRows(seg) || `<p class="empty-steps">${t('Nothing in this moment today. Enjoy the space.')}</p>`}
    </section>
    ${state.source === 'starter' ? premiumInvite(`<a class="btn block" href="${state.user.is_premium ? '#/compose' : '#/premium'}">${t(state.user.is_premium ? 'Compose with my photos' : 'Discover Premium')}</a>`) : ''}
    <div class="section-title"><h2>${t('Nourish and <em>move</em>')}</h2></div>
    <div class="tiles">
      <section class="tile tile-peach"><div class="tile-head">${icon('leaf', 14)} ${t('Nourish')}</div>${stepRows('meal_support')}</section>
      <section class="tile tile-sage"><div class="tile-head">${icon('sun', 14)} ${t('Move')}</div>${stepRows('movement_support')}</section>
    </div>
    <div class="section-title"><h2>${t('Refine your <em>ritual</em>')}</h2>${state.user.is_premium ? '' : `<span class="pill">${icon('lock', 12)} Premium</span>`}</div>
    <div class="refine">
      <button class="btn ghost small" data-action="simplify">${icon('simplify', 16)} ${t('Simplify')}</button>
      <button class="btn ghost small" data-action="swap">${icon('swap', 16)} ${t('Swap ideas')}</button>
      <button class="btn ghost small" data-action="lower_cost">${icon('tag', 16)} ${t('Lower cost')}</button>
    </div>
  `, { tab: '#/home' });

  wrap.querySelectorAll('[data-seg]').forEach((b) => b.addEventListener('click', () => { state.segment = b.dataset.seg; renderHome(); }));
  wrap.querySelectorAll('.step').forEach((row) => row.addEventListener('click', async () => {
    if (row.classList.contains('done')) return;
    row.classList.add('done');
    row.setAttribute('aria-checked', 'true');
    try {
      const data = await api('POST', '/api/ritual/checkin', { ritualId: state.ritualId, stepKey: row.dataset.key, day: today() });
      state.progress = data.progress;
      if (state.progress.length === total) toast(t('Every step done today. Beautifully kept.'));
    } catch (e) {
      toast(t("Couldn’t save that step: {error}", { error: e.message }));
    }
    renderHome();
  }));
  wrap.querySelectorAll('[data-action]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!state.user.is_premium) return nav('#/premium');
    btn.disabled = true;
    try {
      const data = await api('POST', '/api/ritual/revise', { action: btn.dataset.action });
      state.ritual = data.ritual; state.ritualId = data.id; state.progress = data.progress; state.source = data.source;
      toast(t('Maia has refined your ritual.'));
      renderHome();
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  }));
}

/* ---------- Shop ---------- */

// Reads "$18", "₺1.250", "1,299.99 AED": drops thousands separators, accepts a decimal comma.
const priceOf = (s) => Number(String(s).replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.').replace(/[^0-9.]/g, '')) || 0;

async function renderShopping() {
  await loadRitualIfNeeded();
  const items = state.ritual?.shopping || [];
  const now = items.filter((i) => i.tier === 'now');
  const later = items.filter((i) => i.tier !== 'now');
  const total = now.reduce((n, i) => n + priceOf(i.est_price), 0);
  const money = (n) => (now[0]?.est_price || '$0').replace(/[\d.,]+/, n.toLocaleString(LOCALE)); // total in the picks' own currency
  const product = (it) => `<div class="product"><div><h3>${esc(it.item)}</h3><p>${esc(it.reason)}</p></div><span class="price">${esc(it.est_price)}</span></div>`;
  mount(items.length ? `
    <header class="row">${portrait()}<div><div class="eyebrow">${t("Maia’s picks")}</div><h1>${t('What matters <em>first</em>')}</h1></div></header>
    <p class="lede">${t(total
      ? (now.length === 1 ? '{n} essential for {total}. Everything else can wait.' : '{n} essentials for {total}. Everything else can wait.')
      : (now.length === 1 ? '{n} essential. Everything else can wait.' : '{n} essentials. Everything else can wait.'), { n: now.length, total: esc(money(total)) })}</p>
    <section class="glass">
      <div class="eyebrow" style="margin-bottom:4px">${t('Start with')}</div>
      ${now.map(product).join('')}
      ${total ? `<div class="total"><span>${t('Essentials total')}</span><span class="price">${esc(money(total))}</span></div>` : ''}
    </section>
    ${later.length ? `<section class="glass soft"><div class="eyebrow" style="margin-bottom:4px">${t("When you’re ready")}</div>${later.map(product).join('')}</section>` : ''}
  ` : `
    <section class="hero">${arch('sm')}<h1>${t('Your ritual <em>comes first</em>')}</h1><p class="lede">${t('Once your ritual is composed, Maia picks the few things worth buying.')}</p></section>
  `, { tab: '#/shopping' });
}

/* ---------- Progress: examinations + on-device photos ---------- */

// items are newest-first with a `created` ISO date; baseline is the newest item from an earlier day, or >= 7 days older.
function pickBaseline(items, mode) {
  const latest = items[0];
  if (!latest) return null;
  if (mode === 'week') {
    const cutoff = new Date(latest.created).getTime() - 7 * 86400000;
    return items.find((x) => new Date(x.created).getTime() <= cutoff) || null;
  }
  return items.find((x) => localDay(x.created) < localDay(latest.created)) || null;
}

async function renderProgress() {
  const kind = state.progressKind || 'skin';
  const mode = state.compareMode || 'day';
  const [{ examinations }, devicePhotos] = await Promise.all([
    api('GET', `/api/examinations?kind=${kind}`),
    deviceDB.list(kind).catch(() => []),
  ]);
  const exams = examinations.map((e) => ({ ...e, created: e.created_at }));
  const latest = exams[0];
  const base = pickBaseline(exams, mode);
  const photoNow = devicePhotos[0];
  const photoBase = pickBaseline(devicePhotos, mode);
  const newPhoto = {};

  const metrics = latest ? Object.entries(latest.metrics).map(([name, score]) => {
    const prev = base?.metrics?.[name];
    const delta = typeof prev === 'number' ? Math.round((score - prev) * 10) / 10 : null;
    const chip = delta === null ? '' : `<span class="delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : delta < 0 ? '−' : '±'}${fmtScore(Math.abs(delta))}</span>`;
    return `<div class="metric-row"><span class="name">${esc(t(cap(name)))}</span><span class="bar"><i style="width:${Math.max(0, Math.min(100, score * 10))}%"></i></span><span class="val"><strong>${fmtScore(Number(score))}</strong>${chip}</span></div>`;
  }).join('') : '';

  const wrap = mount(`
    <header><div class="eyebrow">${t('Progress')}</div><h1>${t(`Your ${kind}, <em>over time</em>`)}</h1></header>
    <div class="seg" role="group" aria-label="${t('Area')}">
      ${KINDS.map((k) => `<button type="button" data-kind="${k}" aria-pressed="${k === kind}">${icon(KIND_ICON[k], 16)}${kindName(k)}</button>`).join('')}
    </div>
    ${latest ? `
      <section class="glass stack">
        <div class="spread"><h2>${esc(fmtDay(latest.created))}</h2>
          <div class="seg mini" role="group" aria-label="${t('Compare with')}">
            <button type="button" data-mode="day" aria-pressed="${mode === 'day'}">${t('Yesterday')}</button>
            <button type="button" data-mode="week" aria-pressed="${mode === 'week'}">${t('Last week')}</button>
          </div>
        </div>
        ${maiaSays(latest.summary)}
        <div>${metrics}</div>
        <p class="fine">${base ? t('Compared with {date}.', { date: esc(fmtDay(base.created)) }) : t(mode === 'week' ? 'Nothing to compare from a week ago yet.' : 'Nothing to compare from an earlier day yet.')}</p>
      </section>` : `
      <section class="glass hero">
        ${arch('sm')}
        <h2>${t(`Your first <em>${kind}</em> examination`)}</h2>
        <p class="lede">${t(state.user.is_premium ? 'Add a photo below. Maia scores what she sees, then tracks it with you day by day.' : 'Maia scores what she sees, then tracks it with you day by day.')}</p>
      </section>`}
    ${photoNow ? `
      <section class="glass stack">
        <div class="spread"><strong>${t('On this phone only')}</strong><span class="pill">${icon('lock', 12)} ${t('Private')}</span></div>
        <div class="compare-grid">
          ${photoBase ? `<figure><img src="${esc(photoBase.dataUrl)}" alt="${t('Earlier {kind} photo', { kind: kindName(kind).toLocaleLowerCase(LOCALE) })}"><figcaption>${esc(fmtDay(photoBase.created))}</figcaption></figure>` : ''}
          <figure><img src="${esc(photoNow.dataUrl)}" alt="${t('Latest {kind} photo', { kind: kindName(kind).toLocaleLowerCase(LOCALE) })}"><figcaption>${esc(fmtDay(photoNow.created))}</figcaption></figure>
        </div>
        <button class="btn quiet" id="clearDevice">${icon('trash', 16)} ${t('Delete photos on this phone')}</button>
      </section>` : ''}
    ${state.user.is_premium ? `
    <section class="glass stack">
      <h2>${t("Today’s <em>check-in</em>")}</h2>
      <div id="captureSlot"></div>
      <div id="keepSlot"></div>
      <p class="error" id="err" role="alert" hidden></p>
      <button class="btn block" id="analyzeBtn">${t('Analyze')}</button>
    </section>` : premiumInvite(`<a class="btn block" href="#/premium">${t('Discover Premium')}</a>`)}
    ${policyDetails()}
    ${exams.length > 1 ? `
      <section class="glass">
        <div class="eyebrow" style="margin-bottom:4px">${t('History')}</div>
        <div class="timeline">${exams.slice(0, 12).map((x) => {
          const dt = new Date(x.created);
          return `<div class="timeline-item"><div class="when">${dt.getDate()}<small>${esc(dt.toLocaleDateString(LOCALE, { month: 'short' }))}</small></div><p class="muted" style="font-size:14px">${esc(x.summary)}</p></div>`;
        }).join('')}</div>
      </section>` : ''}
  `, { tab: '#/progress' });
  wrap.querySelector('#captureSlot')?.appendChild(photoCapture(kind, newPhoto));
  wrap.querySelector('#keepSlot')?.appendChild(keepOnDeviceToggle());
  wrap.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { state.progressKind = b.dataset.kind; render(); }));
  wrap.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { state.compareMode = b.dataset.mode; render(); }));
  wrap.querySelector('#clearDevice')?.addEventListener('click', async () => {
    if (!confirm(t('Delete all Maia photos saved on this phone?'))) return;
    await deviceDB.clearMine();
    toast(t('Photos deleted from this phone.'));
    render();
  });
  const err = wrap.querySelector('#err');
  wrap.querySelector('#analyzeBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    err.hidden = true;
    if (!newPhoto[kind]) { err.textContent = t('Tick the consent box and choose a photo first.'); err.hidden = false; return; }
    btn.disabled = true;
    btn.textContent = t('Maia is looking…');
    try {
      await submitPhotos(newPhoto);
      toast(t('Examination saved. Your photo leaves our servers tonight.'));
      render();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = t('Analyze');
    }
  });
}

/* ---------- Maia (chat) ---------- */

const SUGGESTIONS = ['Make tonight shorter', 'What can I skip this week?', 'Swap something for sensitive skin'];

async function renderChat() {
  if (!state.user.is_premium) {
    const wrap = mount(`
      <section class="hero">
        ${arch('', true)}
        <div class="eyebrow" lang="en">Maia · Premium</div>
        <h1>${t('Talk with <em>Maia</em>')}</h1>
        <p class="lede">${t('Ask about your ritual, swaps and progress. Calm answers, grounded in your own plan.')}</p>
      </section>
      <a class="btn block" href="#/premium">${icon('gem', 18)} ${t('Unlock with Premium')}</a>
    `, { tab: '#/chat' });
    return;
  }

  const history = await api('GET', '/api/chat/history');
  const hour = new Date().getHours();
  const hello = t("{greeting}. I’m here whenever you want to adjust your ritual or ask about a product.", { greeting: t(hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening') });
  const wrap = mount(`
    <h1 class="sr-only">${t('Talk with Maia')}</h1>
    <header class="chat-head">
      <div class="arch xs"><img src="${MAIA_FULL}" alt="Maia" width="900" height="900"></div>
      <div><h2>Maia</h2><div class="status">${t('Here for your ritual')}</div></div>
    </header>
    <div class="chat-log" id="log" aria-live="polite">
      ${history.messages.length
        ? history.messages.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">${esc(m.content)}</div>`).join('')
        : `<div class="msg assistant">${esc(hello)}</div>`}
      <div class="chips" id="chips" ${history.messages.length ? 'hidden' : ''}>${SUGGESTIONS.map((s) => `<button type="button" class="chip">${esc(t(s))}</button>`).join('')}</div>
    </div>
    <form class="composer" id="composer">
      <input id="msgInput" placeholder="${t('Ask Maia…')}" autocomplete="off" aria-label="${t('Message Maia')}">
      <button class="send" type="submit" aria-label="${t('Send')}">${icon('up', 18)}</button>
    </form>
  `, { tab: '#/chat' });
  const log = wrap.querySelector('#log');
  const input = wrap.querySelector('#msgInput');
  const scrollDown = () => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  const send = async (text) => {
    if (!text) return;
    wrap.querySelector('#chips').hidden = true;
    input.value = '';
    log.appendChild(el(`<div class="msg user">${esc(text)}</div>`));
    const typing = el(`<div class="msg assistant"><span class="typing" aria-label="${t('Maia is writing')}"><i></i><i></i><i></i></span></div>`);
    log.appendChild(typing);
    scrollDown();
    try {
      const data = await api('POST', '/api/chat', { message: text });
      typing.replaceWith(el(`<div class="msg assistant">${esc(data.reply)}</div>`));
    } catch (e) {
      typing.replaceWith(el(`<div class="msg assistant">${esc(e.message)}</div>`));
    }
    scrollDown();
  };
  wrap.querySelector('#composer').addEventListener('submit', (e) => { e.preventDefault(); send(input.value.trim()); });
  wrap.querySelectorAll('#chips .chip').forEach((c) => c.addEventListener('click', () => send(c.textContent)));
  scrollDown();
}

/* ---------- You (account) ---------- */

function renderAccount() {
  const u = state.user;
  const plan = u.is_premium ? `Premium · ${t(cap(u.plan || 'monthly'))}` : t('Free preview');
  const reminders = loadReminders();
  const reminderText = [reminders.am.on && t('Morning {time}', { time: reminders.am.time }), reminders.pm.on && t('Evening {time}', { time: reminders.pm.time })].filter(Boolean).join(' · ') || t('Off');
  const wrap = mount(`
    <h1 class="sr-only">${t('You')}</h1>
    <header class="row"><span class="monogram">${esc((u.email[0] || 'M').toUpperCase())}</span><div class="stack" style="gap:6px;min-width:0"><strong class="email">${esc(u.email)}</strong><span><span class="pill ${u.is_premium ? 'sage' : ''}">${esc(plan)}</span></span></div></header>
    <section class="glass list">
      <a class="list-row" href="#/premium"><span class="ic">${icon('gem')}</span><span class="grow">Maia Premium<small>${u.is_premium && u.premium_until ? t('Renews or ends {date}', { date: esc(fmtDay(u.premium_until)) }) : t('Revisions, chat with Maia and more')}</small></span><span class="chev">${icon('chev', 18)}</span></a>
      <a class="list-row" href="#/reminders"><span class="ic">${icon('bell')}</span><span class="grow">${t('Ritual reminders')}<small>${esc(reminderText)}</small></span><span class="chev">${icon('chev', 18)}</span></a>
      <button class="list-row" id="langRow"><span class="ic">${icon('globe')}</span><span class="grow">${t('Language')}<small>${LANG === 'tr' ? 'Türkçe' : 'English'}</small></span><span class="chev">${icon('chev', 18)}</span></button>
    </section>
    <div class="eyebrow list-label">${t('Privacy')}</div>
    <section class="glass list">
      <div class="list-row static"><span class="ic">${icon('shield')}</span><span class="grow">${t('Photos delete themselves daily')}<small>${t('Nothing kept past the end of your day')}</small></span></div>
      <button class="list-row danger" id="deleteBtn"><span class="ic">${icon('trash')}</span><span class="grow">${t('Delete photos, examinations and chat')}</span></button>
      <button class="list-row danger" id="deleteAccountBtn"><span class="ic">${icon('trash')}</span><span class="grow">${t('Delete my account')}</span></button>
    </section>
    <section class="glass list">
      <a class="list-row" href="/terms.html"><span class="ic">${icon('doc')}</span><span class="grow">${t('Terms of Use')}</span><span class="chev">${icon('chev', 18)}</span></a>
      <a class="list-row" href="/privacy.html"><span class="ic">${icon('doc')}</span><span class="grow">${t('Privacy Policy')}</span><span class="chev">${icon('chev', 18)}</span></a>
      <button class="list-row" id="logoutBtn"><span class="ic">${icon('out')}</span><span class="grow">${t('Log out')}</span></button>
    </section>
  `, { tab: '#/account' });
  wrap.querySelector('#langRow').addEventListener('click', () => setLang(LANG === 'tr' ? 'en' : 'tr'));
  wrap.querySelector('#logoutBtn').addEventListener('click', logout);
  wrap.querySelector('#deleteBtn').addEventListener('click', async () => {
    if (!confirm(t('Delete your photos, examinations and chat history? This cannot be undone.'))) return;
    try {
      await api('POST', '/api/privacy/delete');
      toast(t('Photos, examinations and chat deleted.'));
    } catch (e) {
      toast(t('Nothing was deleted: {error}', { error: e.message }));
    }
  });
  wrap.querySelector('#deleteAccountBtn').addEventListener('click', async () => {
    const storeSub = u.is_premium && ['app_store', 'play_store'].includes(u.billing_source);
    const warning = storeSub
      ? `\n\n${t('Your subscription is billed by {store}. Deleting your account does not cancel it: cancel it in your store subscription settings too.', { store: u.billing_source === 'app_store' ? 'Apple' : 'Google Play' })}`
      : '';
    if (!confirm(`${t('Permanently delete your account, photos, rituals and history?')}${warning}`)) return;
    try {
      await api('POST', '/api/account/delete');
    } catch (e) {
      return toast(e.message);
    }
    await deviceDB.clearMine().catch(() => {});
    await cancelReminders().catch(() => {});
    forgetSession();
    nav('#/auth');
  });
}

/* ---------- Ritual reminders (local notifications, iOS/Android) ---------- */

const REMINDER_DEFAULTS = { am: { on: false, time: '07:30' }, pm: { on: false, time: '21:00' } };
function loadReminders() {
  try { return { ...REMINDER_DEFAULTS, ...JSON.parse(prefGet('maia.reminders') || '{}') }; } catch { return REMINDER_DEFAULTS; }
}
const notify = (method, options = {}) => window.Capacitor.nativePromise('LocalNotifications', method, options);
const cancelReminders = () => (NATIVE ? notify('cancel', { notifications: [{ id: 1 }, { id: 2 }] }) : Promise.resolve());

// Scheduled on the phone itself: no server, no push service, and nothing about the user leaves the device.
async function scheduleReminders(r) {
  await cancelReminders();
  const wanted = [
    r.am.on && { id: 1, title: t('Your morning ritual'), body: t('A few calm minutes to begin the day.'), time: r.am.time },
    r.pm.on && { id: 2, title: t('Your evening ritual'), body: t('Time to unwind. Your ritual is ready.'), time: r.pm.time },
  ].filter(Boolean);
  if (!wanted.length) return;
  const perm = await notify('requestPermissions');
  if (perm.display !== 'granted') throw new Error(t('Notifications are turned off for Maia in your phone settings.'));
  await notify('schedule', {
    notifications: wanted.map(({ id, title, body, time }) => {
      const [hour, minute] = time.split(':').map(Number);
      return { id, title, body, schedule: { on: { hour, minute }, allowWhileIdle: true } };
    }),
  });
}

function renderReminders() {
  const r = loadReminders();
  const row = (key, label, sub) => `
    <label class="switch-row"><span><strong>${t(label)}</strong><small>${t(sub)}</small></span><input type="checkbox" id="${key}On" ${r[key].on ? 'checked' : ''} ${NATIVE ? '' : 'disabled'}><span class="switch"></span></label>
    <label class="field"><span>${t('Time')}</span><input class="input" type="time" id="${key}Time" value="${esc(r[key].time)}" ${NATIVE ? '' : 'disabled'}></label>`;
  const wrap = mount(`
    <div class="wizard-top"><button class="icon-btn" id="backBtn" aria-label="${t('Back')}">${icon('back')}</button></div>
    <header><div class="eyebrow">${t('Reminders')}</div><h1>${t('A gentle <em>nudge</em>')}</h1></header>
    ${maiaSays(t("I’ll remind you once in the morning and once in the evening. Nothing more."))}
    ${NATIVE ? '' : `<p class="note">${t('Reminders work in the Maia app for iPhone and Android.')}</p>`}
    <section class="glass stack">
      ${row('am', 'Morning ritual', 'Every day')}
      <div class="rule"></div>
      ${row('pm', 'Evening ritual', 'Every day')}
    </section>
    <button class="btn block" id="saveBtn" ${NATIVE ? '' : 'disabled'}>${t('Save reminders')}</button>
  `, { tab: '#/account' });
  wrap.querySelector('#backBtn').addEventListener('click', () => nav('#/account'));
  wrap.querySelector('#saveBtn').addEventListener('click', async () => {
    const next = {
      am: { on: wrap.querySelector('#amOn').checked, time: wrap.querySelector('#amTime').value || '07:30' },
      pm: { on: wrap.querySelector('#pmOn').checked, time: wrap.querySelector('#pmTime').value || '21:00' },
    };
    try {
      await scheduleReminders(next);
      prefSet('maia.reminders', JSON.stringify(next));
      toast(t(next.am.on || next.pm.on ? 'Reminders set.' : 'Reminders turned off.'));
      nav('#/account');
    } catch (e) {
      toast(e.message);
    }
  });
}

/* ---------- In-app purchases (iOS / Android via RevenueCat) ---------- */

// Calls the RevenueCat native plugin directly through the Capacitor bridge (the npm wrapper is a thin proxy).
const rcCall = (method, options = {}) => window.Capacitor.nativePromise('Purchases', method, options);
let rcUser = null;

async function storeReady() {
  const apiKey = CONFIG.revenuecat?.[PLATFORM];
  if (!NATIVE || !apiKey) return false;
  if (!rcUser) await rcCall('configure', { apiKey, appUserID: state.user.id });
  else if (rcUser !== state.user.id) await rcCall('logIn', { appUserID: state.user.id });
  rcUser = state.user.id;
  return true;
}

async function storePackages() {
  const pkgs = (await rcCall('getOfferings'))?.current?.availablePackages || [];
  return { monthly: pkgs.find((p) => p.packageType === 'MONTHLY'), annual: pkgs.find((p) => p.packageType === 'ANNUAL') };
}

// The server asks RevenueCat directly after a purchase/restore; if that isn't configured, wait for the webhook.
async function refreshAfterStore() {
  try {
    state.user = await api('POST', '/api/billing/revenuecat-sync');
  } catch {
    for (let i = 0; i < 5 && !state.user.is_premium; i++) {
      await sleep(2000);
      state.user = await api('GET', '/api/me');
    }
  }
}

const STORE_NAME = { ios: 'Apple ID', android: 'Google Play' };
const STORE_MANAGE_URL = { ios: 'https://apps.apple.com/account/subscriptions', android: 'https://play.google.com/store/account/subscriptions?package=com.aethercorp.maia' };

/* ---------- Premium ---------- */

async function renderPremium(status) {
  const billing = await api('GET', '/api/billing/plans');
  if (status === 'success') {
    // Stripe redirects back before its webhook lands; wait briefly instead of showing "not premium" to a paying user.
    mount(`${arch('', true)}<div class="eyebrow" lang="en">Maia Premium</div><h1>${t('Activating your <em>ritual</em>')}</h1><p class="lede">${t('This usually takes a few seconds.')}</p>`, { noir: true, fill: true });
    state.user = await api('GET', '/api/me');
    for (let i = 0; i < 5 && !state.user.is_premium; i++) {
      await sleep(2000);
      state.user = await api('GET', '/api/me');
    }
  }
  const store = NATIVE && await storeReady().catch(() => false);
  const pkgs = store ? await storePackages().catch(() => ({})) : {};
  const u = state.user;
  let selected = state.selectedPlan || 'annual';
  const local = (s, n = priceOf(s)) => s.replace(/[\d.,]+/, n.toLocaleString(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const planOf = (id) => {
    const p = billing.plans.find((x) => x.id === id);
    return { ...p, price: pkgs[id]?.product?.priceString || local(p.price) }; // store prices arrive already localized
  };
  const perMonth = (p) => (p.period === 'year' && priceOf(p.price)
    ? t('{price} a month, billed yearly', { price: local(p.price, priceOf(p.price) / 12) })
    : t('Cancel anytime'));
  const manageHint = {
    stripe: NATIVE ? 'Manage or cancel on the Maia website.' : 'Manage or cancel anytime below.',
    app_store: 'Manage or cancel in your Apple ID subscription settings.',
    play_store: 'Manage or cancel in Google Play → Subscriptions.',
    dev: 'Test upgrade: no payment was taken.',
  }[u.billing_source] || '';
  const benefits = [
    ['camera', t('Daily photo check-ins'), t('Skin, hair and posture, compared day by day and week by week')],
    ['sparkle', t('A ritual written for you'), t('Composed by Maia from your photos, not a template')],
    ['repeat', t('Revise in one tap'), t('Simplify, swap or lower the cost')],
    ['chat', t('Talk with Maia'), t('Up to {n} questions a day, answered calmly', { n: billing.limits.premium.chat[0] })],
  ];

  const wrap = mount(`
    <div class="spread"><button class="icon-btn" id="closeBtn" aria-label="${t('Close')}">${icon('close')}</button><span></span></div>
    <section class="hero" style="padding-top:0">
      ${arch('sm', true)}
      <div class="eyebrow" lang="en">Maia Premium</div>
      <h1 class="display">${t(u.is_premium ? 'Your ritual, <em>in full.</em>' : 'The full ritual, <em>every day.</em>')}</h1>
    </section>
    <div class="rule"></div>
    ${u.is_premium ? `
      <section class="glass stack">
        <h2>${t("You’re on <em>Premium</em>")}</h2>
        <p class="lede">${t('{plan} plan', { plan: esc(t(cap(u.plan || 'monthly'))) })}${u.premium_until ? t(' · renews or ends {date}', { date: esc(fmtDay(u.premium_until)) }) : ''}</p>
        <p class="fine">${esc(t(manageHint))}</p>
        ${u.billing_source === 'stripe' && !NATIVE ? `<button class="btn ghost block" id="portalBtn">${t('Manage subscription')}</button>` : ''}
        ${NATIVE && STORE_MANAGE_URL[PLATFORM] && !['stripe', 'dev'].includes(u.billing_source) ? `<button class="btn ghost block" id="storeManageBtn">${t('Manage subscription')}</button>` : ''}
      </section>` : `
      <div class="plans" role="radiogroup" aria-label="Plan">
        ${billing.plans.map((x) => planOf(x.id)).map((p) => `
          <button type="button" class="plan" role="radio" data-plan="${esc(p.id)}" aria-checked="${p.id === selected}">
            <span class="radio"></span>
            <span class="grow"><strong>${esc(t(p.label))}</strong><small>${esc(perMonth(p))}</small></span>
            <span class="price">${esc(p.price)}</span>
            ${p.note ? `<span class="pill gold badge">${esc(t(p.note))}</span>` : ''}
          </button>`).join('')}
      </div>
      <p class="error" id="err" role="alert" hidden></p>
      <button class="btn block" id="buyBtn"></button>
      <p class="fine" id="disclosure"></p>
      ${NATIVE ? `<button class="btn quiet" id="restoreBtn">${t('Restore purchases')}</button>` : ''}
      ${billing.devUpgrade ? `<button class="btn ghost small" id="devBtn">${t('Payments not configured: unlock for testing')}</button>` : ''}
      <section class="glass benefits">
        ${benefits.map(([ic, title, sub]) => `<div class="benefit"><span class="ic">${icon(ic, 18)}</span><div><strong>${esc(title)}</strong><span>${esc(sub)}</span></div></div>`).join('')}
      </section>`}
    <p class="fine center"><a href="/terms.html">${t('Terms of Use')}</a> · <a href="/privacy.html">${t('Privacy Policy')}</a></p>
  `, { noir: true });
  wrap.querySelector('#closeBtn').addEventListener('click', () => (history.length > 1 ? history.back() : nav('#/home')));
  const buyBtn = wrap.querySelector('#buyBtn');
  const disclosure = wrap.querySelector('#disclosure');
  const update = () => {
    if (!buyBtn) return;
    const p = planOf(selected);
    buyBtn.textContent = t('Continue with {plan}', { plan: t(p.label) });
    const vars = { store: STORE_NAME[PLATFORM], price: p.price, period: t(p.period) };
    disclosure.textContent = NATIVE
      ? t('Payment is charged to your {store} account at confirmation of purchase. The subscription renews automatically at {price} per {period} unless cancelled at least 24 hours before the end of the current period; renewal is charged within 24 hours before the period ends. Manage or cancel anytime in your {store} subscription settings.', vars)
      : t('Payment is charged at confirmation. The subscription renews automatically at {price} per {period} unless cancelled at least 24 hours before the end of the current period. Cancel anytime from You → Maia Premium.', vars);
  };
  update();
  wrap.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => {
    selected = state.selectedPlan = b.dataset.plan;
    wrap.querySelectorAll('[data-plan]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    update();
  }));

  const err = wrap.querySelector('#err');
  const showErr = (m) => { err.textContent = m; err.hidden = false; };
  buyBtn?.addEventListener('click', async () => {
    buyBtn.disabled = true;
    try {
      if (!NATIVE) {
        location.href = (await api('POST', '/api/billing/checkout', { plan: selected })).url;
        return;
      }
      if (!store) throw new Error(t('In-app purchases are not set up yet'));
      if (!pkgs[selected]) throw new Error(t('This plan is not available in the store yet'));
      await rcCall('purchasePackage', { aPackage: pkgs[selected] });
      await refreshAfterStore();
      renderPremium();
    } catch (e) {
      if (!/cancel/i.test(e.message || '')) showErr(e.message);
      buyBtn.disabled = false;
    }
  });
  wrap.querySelector('#restoreBtn')?.addEventListener('click', async () => {
    try {
      if (!store) throw new Error(t('In-app purchases are not set up yet'));
      await rcCall('restorePurchases');
      await refreshAfterStore();
      if (!state.user.is_premium) throw new Error(t('No active Maia subscription found for this {store} account.', { store: STORE_NAME[PLATFORM] }));
      renderPremium();
    } catch (e) {
      showErr(e.message);
    }
  });
  wrap.querySelector('#storeManageBtn')?.addEventListener('click', () => { location.href = STORE_MANAGE_URL[PLATFORM]; });
  wrap.querySelector('#devBtn')?.addEventListener('click', async () => {
    await api('POST', '/api/subscribe');
    state.user = await api('GET', '/api/me');
    toast(t('Premium unlocked for testing.'));
    renderPremium();
  });
  wrap.querySelector('#portalBtn')?.addEventListener('click', async () => {
    location.href = (await api('POST', '/api/billing/portal')).url;
  });
}

/* ---------- Router ---------- */

function renderLoading() {
  mount(`${arch('sm', true)}<div class="eyebrow" lang="en">Maia</div>`, { fill: true });
}

function renderError(message) {
  const wrap = mount(`
    ${arch('sm')}
    <div class="eyebrow">${t('A small pause')}</div>
    <h1>${t('Something needs <em>a moment</em>')}</h1>
    <p class="lede" role="alert">${esc(message)}</p>
    <div class="stack" style="width:100%">
      <button class="btn block" id="retryBtn">${t('Try again')}</button>
      <button class="btn ghost block" id="homeBtn">${t('Back to my ritual')}</button>
    </div>
  `, { fill: true, tab: state.user ? '#/none' : undefined });
  wrap.querySelector('#retryBtn').addEventListener('click', render);
  wrap.querySelector('#homeBtn').addEventListener('click', () => nav('#/home'));
}

// Any failed request inside a screen (expired session, daily limit, network) lands here instead of a blank page.
async function render() {
  const slow = setTimeout(renderLoading, 250);
  try {
    await route();
  } catch (e) {
    if (e.status === 401) {
      forgetSession();
      return renderAuth();
    }
    renderError(e.message || t('Please check your connection and try again.'));
  } finally {
    clearTimeout(slow);
  }
}

async function route() {
  const [hash, query] = (location.hash || '#/auth').split('?');
  const params = new URLSearchParams(query);
  if (hash === '#/reset') return renderReset(params.get('token'));
  if (!state.user) {
    try { state.user = await api('GET', '/api/me'); } catch { /* not logged in */ }
  }
  if (!state.user) return hash === '#/forgot' ? renderForgot() : renderAuth();
  if (state.user.lang !== LANG) { // keep the server in step, so Maia writes rituals and replies in the app's language
    state.user.lang = LANG;
    api('POST', '/api/settings', { lang: LANG }).catch(() => {});
  }
  if (!state.user.email_verified) return renderVerifyEmail(hash === '#/verify-failed');
  if (!state.user.onboarding_complete && hash !== '#/onboarding') return nav('#/onboarding');

  if (hash === '#/onboarding') return renderOnboarding();
  if (hash === '#/compose') return renderCompose();
  if (hash === '#/progress') return renderProgress();
  if (hash === '#/shopping') return renderShopping();
  if (hash === '#/chat') return renderChat();
  if (hash === '#/account') return renderAccount();
  if (hash === '#/reminders') return renderReminders();
  if (hash === '#/premium') return renderPremium(params.get('status'));
  return renderHome();
}

window.addEventListener('hashchange', render);
render();
