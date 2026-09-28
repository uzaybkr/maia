# Store release notes (Maia v0.2)

Everything here must match what the code actually does. Re-check it if the photo policy or data use changes.

## Server environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `APP_URL` | Email links, Stripe redirects | Public HTTPS origin, e.g. `https://app.yourdomain.com`. **An https `APP_URL` (or `NODE_ENV=production`) switches on production mode**: HSTS, Secure cookies, no test upgrade. The server then **refuses to start** without `MAIA_PHOTO_KEY` and `RESEND_API_KEY`. |
| `MAIA_PHOTO_KEY` | Photo encryption | 64 hex chars (`openssl rand -hex 32`); keep in a secret manager, never next to the data |
| `MAIA_DATA_DIR` | Main database (`maia.db`) | Defaults to `~/.maia`. Put it on a persistent volume and **back this file up**. |
| `MAIA_PHOTO_DB` | Photo database | **Required in production, and must be outside `MAIA_DATA_DIR`** (the server refuses to start otherwise). Point it at an ephemeral, never-snapshotted volume. Everything in it expires within 24h, and the privacy policy promises no photo backups. In dev it defaults to `$MAIA_DATA_DIR/photos.db`. |
| `MAIA_AI_DAILY_CAP` | Paid AI kill-switch | Total AI calls across all users per 24h (default 2000); set it to what your budget allows. Free members make no AI calls (they get a no-AI starter ritual). Per premium user (see `AI_LIMITS` in `server.js`): 6 analyses a day, 3 new rituals a week, 3 revisions and 15 chat messages a day. Everyone is capped at 10 calls a minute. Each attempt is logged before the model is called, so deleting history or a failed call can't reset the budget. |
| `TRUST_PROXY=1` | Behind a load balancer | Rate limits then use the address your proxy appends (the rightmost `X-Forwarded-For` entry). Only set this when a proxy you control always adds that header. |
| `GET /healthz` | Load balancer health check | Returns `{"ok":true}` |
| `ANTHROPIC_API_KEY` | Real AI | New rituals use `claude-opus-5-5`; check-ins, revisions and chat use `claude-sonnet-5`. Override per task with `MAIA_MODEL_RITUAL`, `MAIA_MODEL_REVISE`, `MAIA_MODEL_EXAM`, `MAIA_MODEL_CHAT` |
| `RESEND_API_KEY`, `MAIL_FROM` | Verification emails | Verify the sending domain in Resend |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL` | Web subscriptions | Webhook URL `/api/billing/stripe-webhook`; events: `checkout.session.completed`, `customer.subscription.created/updated/deleted` |
| `REVENUECAT_WEBHOOK_AUTH`, `REVENUECAT_SECRET_KEY`, `REVENUECAT_ENTITLEMENT` | iOS/Android subscriptions | Webhook URL `/api/billing/revenuecat-webhook`; set the same Authorization value in the RevenueCat dashboard; entitlement defaults to `premium` |

App build settings live in `public/config.js`: `apiBase` (the server's HTTPS URL) and the RevenueCat public SDK keys (`appl_…`, `goog_…`).

## Subscription products

- App Store Connect: subscription group "Maia Premium", with products `maia_premium_monthly` and `maia_premium_annual`.
- Play Console: the same two product IDs.
- RevenueCat: entitlement `premium` attached to both products, and offering `default` with packages `$rc_monthly` and `$rc_annual`.
- Product IDs must contain `annual` for the yearly plan: the server maps plans by that word.

## Apple: App Privacy ("nutrition label")

No data is used for tracking. All data below is linked to the user and used for App Functionality.

| Apple category | What we collect |
|---|---|
| Contact Info → Email Address | account |
| User Content → Photos or Videos | skin/hair/posture photos, deleted within 24h |
| User Content → Other User Content | profile answers, examinations, chat messages |
| Purchases → Purchase History | plan and renewal date |
| Identifiers → User ID | internal ID shared with RevenueCat |
| Health & Fitness | **Decide with counsel.** Sleep/energy goals and skin examinations may fall here. Declaring it is the safer choice. |

Other App Store answers:
- **Export compliance:** `ITSAppUsesNonExemptEncryption = false` is already set; the app uses standard HTTPS only.
- **Age rating:** answer the content questionnaire honestly (it likely yields 4+). The app itself enforces 18+ at signup; consider 17+ to match.
- **Sign in with Apple:** not required, because there is no third-party login.

## Google Play: Data safety form

- Data is encrypted in transit: Yes.
- Users can request deletion: Yes, in-app (Account → Privacy); account deletion also removes all data.
- Personal info → Email address: collected, required, for App functionality and Account management.
- Photos: collected, optional, for App functionality. **Not "processed ephemerally"**, because photos are kept until the end of the user's day (up to 24h).
- App data is excluded from Android backup and device transfer (`allowBackup=false` plus `data_extraction_rules.xml`). On iOS, WebKit storage is excluded from backups in `AppDelegate.swift`.
- Messages → Other in-app messages: collected, optional (chat with Maia).
- App activity → Other user-generated content / In-app actions: profile answers, examinations, ritual check-ins.
- Financial info → Purchase history: collected.
- Health and fitness: same decision as Apple.
- Shared with third parties: none. Processors acting for us (AI, payments, email, hosting) don't count as "sharing" under Google's definition.

## Review notes (paste into both consoles)

> Maia is a wellness app, not a medical device. It never diagnoses. Photos are optional, uploaded only after per-photo consent, encrypted, and deleted from our servers at the end of the user's day. Test account: [email] / [password] (email already verified). Premium can be bought with sandbox accounts; "Restore purchases" is on the Premium screen. Account deletion is under Account → Privacy.

## Required URLs

- Privacy Policy: `https://<domain>/privacy.html`
- Terms of Use (EULA): `https://<domain>/terms.html`. Apple requires this link in the app description for auto-renewing subscriptions.
- Support URL / email: [to decide]

## Before submitting

- [ ] Lawyer review of `privacy.html` and `terms.html`; fill in every `[bracket]`
- [ ] Confirm the AI provider's data retention (zero-data-retention agreement) matches the privacy copy
- [ ] Deploy the server on HTTPS and set `apiBase` in `public/config.js`. Also narrow `connect-src` in `public/index.html` from `https:` to that exact origin. Then run `npx cap sync`.
- [ ] In Xcode, archive and check Product → Generate Privacy Report. Add an app-level `PrivacyInfo.xcprivacy` if it lists undeclared required-reason APIs.
- [ ] Screenshots: 6.9" and 6.5" iPhone, 13" iPad (if iPad stays enabled), and Play phone screenshots
- [ ] iPad: either design for it or remove iPad from supported devices in Xcode
