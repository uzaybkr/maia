# Maia v0.2 todo

## Phase 1: Privacy-first photos
- [x] T1 `POST /api/examinations`: photo sealed until end of user's local day, purged at startup + every 10 min
- [x] T2 Consent gates the file picker + photo policy copy
- [x] T3 Progress tab: day/week comparison of examinations
- [x] T4 Optional on-device photo keeping (IndexedDB, per-owner) + delete
- [x] Checkpoint 1: tests green + browser walkthrough

## Phase 2: Verification
- [x] T5 18+ confirmation at signup
- [x] T6 Email verification (Resend or dev log), gate AI + purchases
- [x] Checkpoint 2

## Phase 3: Web payments
- [x] T7 Entitlement model (plan, premium_until, billing_source)
- [x] T8 Paywall page with store-required disclosures
- [x] T9 Stripe Checkout + signed webhook
- [x] Checkpoint 3

## Phase 4: Three apps
- [x] T10 Bearer auth + CORS + API base for native clients
- [x] T11 Capacitor android + ios projects, permissions, icons
- [x] T12 RevenueCat in-app purchase + webhook + server-side sync (device test needs store sandbox)
- [x] T13 Terms/Privacy pages (DRAFT, legal review) + `tasks/store-compliance.md`
- [x] Checkpoint 4: tests green, `cap sync` clean, `cap doctor` Android OK (iOS needs a Mac)

## Ship gate hardening (from /ship review)
- [x] Rightmost-XFF rate limiting + per-email login limit
- [x] AI budget counted from stored rows (survives restarts) + burst limit + global kill-switch
- [x] Account delete cancels Stripe subscriptions; store-billed users warned to cancel in the store
- [x] Cross-channel entitlement guard; Stripe events re-fetch live subscription state
- [x] Photos in separate never-backed-up DB; Android/iOS device backups excluded
- [x] Production auto-detected from https APP_URL, refuses to boot without secrets
- [x] 415 for non-JSON posts (login CSRF), 4MB body cap, fetch timeouts, log hygiene
- [x] No fake scores stored when AI fails; goals sanitized; signup race → 409
- [x] Password reset (forgot/reset, logs out everywhere)
- [x] Client: error screen instead of blank page, keyboard-accessible chips, labels, AA contrast
- [x] Round 2: append-only `ai_calls` budget, photo DB must live outside backed-up dir, per-channel `entitlements`, Stripe access from all customer subs, failure-only per-email login limit, non-invalidating reset links
- [x] Re-verification: code-reviewer GO, security-auditor GO, test-engineer: payment paths adequately tested

## Phase 5: Release
- [x] T14a Web walkthrough: signup + 18+ + terms, verify + resend, onboarding, progress, paywall, legal pages, phone viewport
- [ ] T14b Android debug build (needs Android Studio: JDK 21 + SDK) — user action
- [ ] T14c iOS build (needs a Mac with Xcode, or a cloud Mac build) — user action
