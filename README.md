# Maia

A self-care app built on Claude. Users pick their goals and, with Premium, add skin, hair and posture photos. Claude writes a daily routine, scores the photos over time and answers follow-up questions. It runs on the web, iPhone and Android, in English and Turkish.

[![Apps](../../actions/workflows/apps.yml/badge.svg)](../../actions/workflows/apps.yml)

- **Server:** Node 24 with no runtime dependencies (`node:http`, `node:sqlite`, `node:crypto`): `server.js` + `lib/`.
- **App:** plain JavaScript in `public/` with no build step, wrapped for iOS and Android with Capacitor 8.
- **Payments:** Stripe on the web; App Store and Google Play through RevenueCat in the apps.

## How the AI layer works

| Concern | How it's handled | Where |
|---|---|---|
| **Model routing** | Each task gets its own model, effort level and `max_tokens` cap. The first ritual, built from photos, is rare and is the core of the product, so it runs on Opus. Check-ins, revisions and chat are frequent, so they run on Sonnet at low effort. Any task can be overridden with `MAIA_MODEL_<TASK>`. | [`lib/ai.js`](lib/ai.js) |
| **Cost control** | Every AI call is logged *before* the provider is called, so failed calls count and a restart can't reset the budget. Limits apply per user and per task, plus a per-minute limit and a global daily cap. `MAIA_AI_DAILY_CAP=0` stops all AI spending at once. The free tier makes no AI calls. | [`server.js`](server.js) (`AI_LIMITS`) |
| **Structured output** | Prompts ask for JSON only. Replies are parsed, checked against the expected shape and clamped. A reply that was cut off or refused counts as a failure; it is never shown as a score. | `normalizeRitual`, `normalizeExamination` |
| **Vision** | Photos are sent as base64 image blocks. Each area (skin, hair, posture) has a fixed set of metrics scored 0–10, so scores can be compared from day to day. | `examinePhoto` |
| **Safety scope** | The prompts frame Maia as wellness guidance and never a diagnosis. Maia never comments on body shape or weight. An unclear photo gets neutral scores and an honest summary. | system prompts in `lib/ai.js` |
| **Photo privacy** | Photos are encrypted at rest with AES-256-GCM. They live in a separate database kept out of backups, with `secure_delete` on, and are deleted at the end of the user's local day. Logs record token counts only, never content. | [`lib/vault.js`](lib/vault.js), [`lib/photos.js`](lib/photos.js) |
| **Two languages** | The user's language drives the prompts, the fallback routines and emails. The tests fail if any phrase on screen has no Turkish version. | [`public/i18n.js`](public/i18n.js) |
| **Offline fallback** | Without an API key the app still works. It uses rule-based routines and sample scores labelled "fallback", so local development costs nothing. | `lib/ai.js` |

Comments marked `Known limit:` name each simplification on purpose and how to upgrade it.

## Tests and CI

`npm test` runs one smoke suite (about 10 seconds) against a real server with a stubbed Claude API. It covers model routing, refused or cut-off replies, the cost limits, XSS escaping, missing translations and production start-up checks. On every push, GitHub Actions runs the tests and builds both the Android APK and the iOS app.

## Run it locally

```bash
npm install
npm run dev        # http://localhost:3300, restarts on changes
npm test           # one smoke suite, about 10 seconds
```

Locally there is a `demo` / `demo` login, email links are shown on screen instead of sent, and a "unlock for testing" button gives Premium without paying. None of this exists in production: the server removes the demo account and any test Premium when it starts in production.

## Settings (environment variables)

Production is on when `NODE_ENV=production` or `APP_URL` starts with `https://`. It refuses to start if a required setting is missing.

| Variable | Needed | What it is |
|---|---|---|
| `APP_URL` | production | Public `https://` address of the server; used in email links |
| `ANTHROPIC_API_KEY` | production | Claude API key |
| `RESEND_API_KEY` | production | Email (verification, password reset) |
| `MAIL_FROM` | production | Sender, on a domain verified in Resend, e.g. `Maia <hello@yourdomain.com>` |
| `MAIA_PHOTO_KEY` | production | 64 hex chars (32 bytes) that encrypt photos. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Keep it in a secret manager, never in backups |
| `MAIA_PHOTO_DB` | production | Photo database path, **outside** `MAIA_DATA_DIR` so photos never reach backups |
| `MAIA_DATA_DIR` | | Data folder (default `~/.maia`); back this up |
| `MAIA_DB` | | Main database (default `MAIA_DATA_DIR/maia.db`) |
| `PORT` | | Default `3300` |
| `TRUST_PROXY` | behind a proxy | Set to `1` when a host/load balancer sits in front (Render, Fly, Railway…), so rate limits see real addresses |
| `MAIA_AI_DAILY_CAP` | | Most AI calls per day across all users (default `2000`). **`0` stops all AI at once** |
| `MAIA_MODEL_RITUAL` / `_REVISE` / `_EXAM` / `_CHAT` | | Override the Claude model per task |
| `STRIPE_SECRET_KEY` | web payments | Turns on Stripe; then these are required: |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL` | with Stripe | Webhook signing secret and the two price IDs |
| `REVENUECAT_SECRET_KEY` | app payments | Turns on RevenueCat; then `REVENUECAT_WEBHOOK_AUTH` is required |
| `REVENUECAT_WEBHOOK_AUTH` | with RevenueCat | The Authorization value set on the RevenueCat webhook |
| `REVENUECAT_ENTITLEMENT` | | Entitlement id (default `premium`) |

Webhooks: Stripe → `https://<server>/api/billing/stripe-webhook`, RevenueCat → `https://<server>/api/billing/revenuecat-webhook`. Health check: `GET /healthz`.

## Deploy

1. Any host that runs Node 24 with a persistent disk works. One instance only (the AI limits are counted in one process).
2. Set the variables above, with the data folder on the persistent disk and the photo database on a separate path.
3. Point a domain at it over HTTPS, then set `APP_URL`.
4. Back up `MAIA_DATA_DIR` daily. Do not back up `MAIA_PHOTO_DB` or the photo key.

**Emergency brake:** set `MAIA_AI_DAILY_CAP=0` and restart to stop all AI spending immediately. To roll back, redeploy the previous git commit.

## Phone apps

1. In `public/config.js` set `apiBase` to the server's HTTPS address and the RevenueCat public keys.
2. In `public/index.html`, narrow `connect-src https:` to that address.
3. `npx cap sync`, then open `android/` in Android Studio or `ios/` in Xcode (needs a Mac).
4. The app ID is still `com.aethercorp.maia`; change it to the owner's before the first store upload, because it can never change afterwards.

Store checklist (privacy labels, screenshots, review notes): `tasks/store-compliance.md`.

## Maintenance

- `npm run vendor` copies anime.js into `public/vendor/` after upgrading it.
- Every on-screen English phrase needs a Turkish entry in `public/i18n.js`; the tests fail otherwise, including server error messages.
- Legal pages (`public/terms.html`, `public/privacy.html`) still have `[placeholders]` and need a lawyer's review, plus a Turkish (KVKK) version.

## License

All rights reserved. The source is public as a portfolio sample and is not licensed for reuse.
