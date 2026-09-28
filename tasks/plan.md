# Maia v0.2 plan: payments, verification, 3 apps, zero-retention photos

Source requirements: user request 2026-09-25 + `founder-pack/maia-prd.md` (P0 subscription gating, P2 annual plan, privacy section 13).

## Decisions (defaults — change before Phase 1 starts if wrong)

| Topic | Default | Why |
|---|---|---|
| Photo retention | **Deleted at the end of the user's local day (hard cap 24h).** Stored AES-GCM sealed in a separate `photos` table with `expires_at`; a purge runs at startup and every 10 min; expired rows are never served. Only the written examination is kept long-term. | User decision 2026-09-25: allows same-day re-analysis and ritual generation |
| Photo comparison | Examinations (scores + notes) compared by day/week on the server; photos optionally kept **on the user's device only** (IndexedDB) for side-by-side view | Matches "we don't store your photos" promise |
| Web payments | Stripe Checkout (subscription) + signed webhook | No SDK needed (REST + HMAC in stdlib) |
| iOS/Android payments | Native in-app purchase through RevenueCat (`@revenuecat/purchases-capacitor`) + webhook | Apple 3.1.1 / Google Play billing policy require store billing for digital subscriptions; RevenueCat handles receipt validation for both stores |
| Email verification | Resend REST API; without a key, the verify link is printed to the server log | Runs today, real email later |
| Native wrapper | Capacitor 8, web assets bundled into the app (not a remote URL) | One codebase for 3 apps; bundled assets reduce App Store 4.2 "web wrapper" rejection risk |
| App ID | `com.aethercorp.maia` | Confirmed 2026-09-28 (Aether Corp). Permanent once published |
| Prices | Monthly $14.99, Annual $119.99 (display placeholders) | Real prices live in Stripe / App Store Connect / Play Console |

## Dependency graph

```
T1 analyze-and-destroy ──┬─> T2 consent UI ──> T3 progress/compare ──> T4 on-device photos
                         │
T5 18+ ──> T6 email verify ──> (gates AI + purchases)
                                   │
T7 entitlements ──> T8 paywall ──> T9 Stripe web
                         │
T10 native-ready client (bearer auth, CORS, API base) ──> T11 Capacitor android+ios ──> T12 RevenueCat IAP
                                                                                  └──> T13 store compliance
T14 release verification (needs all)
```

## Phase 1: Privacy-first photos

**T1. Analyze-then-expire endpoint.** `POST /api/examinations {kind, photo, consent, tzOffset}` validates the photo, runs the AI (or a labelled sample fallback), stores the examination `{kind, metrics, summary, created_at}` permanently, and stores the sealed photo in `photos` with `expires_at` set to the end of the user's local day (capped at 24h). A purge deletes expired photos at startup and every 10 minutes. Photos move out of the profile JSON. Onboarding submits photos through this endpoint.
- Accept: the photo is sealed at rest; an expired photo is purged and never served; the examination survives the purge; a photo without consent is rejected (400).
- Verify: `test.js` back-dates `expires_at`, runs the purge, and checks the raw DB.

**T2. Consent + warning UI.** Required consent checkbox per photo, with plain copy: analyzed, then permanently deleted from our servers; only the written examination is kept; the AI provider's own retention terms apply.
- Accept: the capture button stays disabled until consent is ticked; the copy is shown before any upload.
- Verify: browser check.

**T3. Progress and comparison.** `GET /api/examinations?kind=` plus a "Progress" tab: the latest examination versus the previous day or week, with metric deltas.
- Accept: two examinations on different days show deltas; the week view groups correctly.
- Verify: `test.js` with back-dated rows, plus a browser check.

**T4. Optional on-device photos.** Opt-in toggle "Keep a copy on this device" with a warning. Photos go to IndexedDB with a date, are shown side-by-side with the examinations, and have a "Delete device photos" button.
- Accept: a device photo survives a reload; nothing is sent to the server; delete clears the IndexedDB store.
- Verify: browser check (IndexedDB inspection).

**Checkpoint 1:** `npm test` green, and a browser walkthrough of photo → examination → compare.

## Phase 2: Verification

**T5. Adults only.** Signup requires `age_confirmed: true`; the server rejects signup without it and stores `age_confirmed_at`.
- Verify: `test.js` covers signup without the flag → 400.

**T6. Email verification.** On signup, create a random token (stored hashed, 24h expiry); send it via Resend if `RESEND_API_KEY` is set, otherwise log the link. `GET /verify?token=` marks the email verified; `POST /api/verify/resend` is rate-limited. AI endpoints and purchases require a verified email; the UI shows a banner.
- Accept: an unverified user gets 403 on generate/checkout; the link verifies; an expired or used token fails.
- Verify: `test.js` reads the token from the dev log hook.

**Checkpoint 2.**

## Phase 3: Web payments

**T7. Entitlements.** Add `plan`, `premium_until` and `billing_source` to users; `isPremium(user)` checks expiry and replaces the `is_premium` flag everywhere. The dev mock upgrade stays, but not in production.
- Verify: an expired `premium_until` loses access (test).

**T8. Paywall page.** Monthly and annual plans, what's included, price, period, auto-renew disclosure, Terms and Privacy links, Restore purchases (native), Manage subscription.
- Verify: browser check; the Apple 3.1.2 disclosure elements are present.

**T9. Stripe web checkout.** `POST /api/billing/checkout` creates a Checkout Session (mode=subscription, `client_reference_id`=user id). `POST /api/billing/stripe-webhook` verifies `Stripe-Signature` (HMAC-SHA256, 5-minute tolerance) and handles `checkout.session.completed` and `customer.subscription.updated`/`deleted` to update the entitlement. Without keys it returns 503 "payments not configured".
- Accept: a forged or unsigned webhook gets 400; a correctly signed event grants premium.
- Verify: `test.js` signs a fake event with a test secret.

**Checkpoint 3.**

## Phase 4: Three apps

**T10. Native-ready client.** Add `API_BASE` config. Native clients use `Authorization: Bearer` (token returned only when `x-maia-client: native`); the web keeps HttpOnly cookies. Add CORS for `capacitor://localhost` and `https://localhost` only.
- Verify: `test.js` exercises the bearer flow and checks that a foreign origin is refused.

**T11. Capacitor scaffold.** Add `capacitor.config.json`, the `android/` and `ios/` projects, camera and photo-library permission strings (iOS Info.plist, Android manifest), and an icon and splash screen generated from the Maia sculpture asset.
- Verify: `npx cap sync` succeeds; the Android build needs Android Studio (JDK 21 + SDK), which this PC doesn't have yet; iOS needs a Mac with Xcode.

**T12. Native IAP.** On native, the paywall buys through RevenueCat (`appUserID` = our user id). `POST /api/billing/revenuecat-webhook` authenticates with a shared-secret header and updates the entitlement.
- Verify: `test.js` covers the webhook; the purchase flow needs store sandbox accounts (user action).

**T13. Store compliance.** Terms and Privacy pages (placeholders marked for legal review), in-app account deletion (done), and draft notes for the privacy nutrition label (Apple) and Data safety form (Google). Photos can't be declared "processed ephemerally" on Google Play, because the end-of-day retention keeps them up to 24h; see `tasks/store-compliance.md`.

**Checkpoint 4.**

## Phase 5: Release verification

**T14.** Web: `npm test` plus a full browser walkthrough. Android: debug APK built in Android Studio. iOS: build on a Mac or a cloud Mac CI service. User actions: Stripe keys, RevenueCat project, App Store Connect and Play Console apps, Resend key, Anthropic key (plus a zero-data-retention agreement if "destroyed everywhere" is promised).

## Risks

- **AI provider retention:** photos sent for analysis fall under the provider's retention terms. The "we destroy it" promise is only fully true end-to-end with a zero-data-retention agreement. The consent copy must not over-promise until then.
- **Medical framing:** examinations use wellness language (hydration, evenness, clarity), never diagnosis. Keep the PRD's claims posture.
- **App Store 4.2:** mitigated by bundled assets, native camera and IAP, and offline shell.
- **App ID is permanent:** `com.aethercorp.maia`, confirmed 2026-09-28.
