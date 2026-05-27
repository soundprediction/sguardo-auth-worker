# sguardo-auth-worker

Cloudflare Worker that handles the **OAuth authorization-code → access-token exchange** for FHIR data providers that require **confidential-client OAuth** (i.e. don't offer a public PKCE flow that a mobile app can use directly).

Supported providers (registered in `src/index.ts`):
**CMS Blue Button 2.0**, **Humana**, **UnitedHealthcare**, **Anthem BCBS**, **Aetna**, **Cigna**, **Kaiser Permanente**, **Centene**, **Molina Healthcare**, **Quest Diagnostics**, **Labcorp**.

Public-PKCE providers (e.g. **Epic MyChart**) are intentionally NOT routed through this Worker — the app completes their token exchange directly.

> **For forks and downstream open-source contributors**: this code is open source, but the deployed Worker at `oauth.soundprediction.com` is Sound Prediction's production instance — only that team has the matching client_secrets. If you're shipping your own build of Sguardo, see [§10 Adapting for your fork](#10-adapting-for-your-fork). **Never commit `.dev.vars`, real `client_secret` values, or `wrangler secret put` output** — the `.gitignore` blocks `.dev.vars`; double-check before pushing.

---

## Table of contents

1. [Why this exists](#1-why-this-exists)
2. [Architecture](#2-architecture)
3. [Prerequisites](#3-prerequisites)
4. [First-time setup](#4-first-time-setup)
5. [Deploy + test](#5-deploy--test)
6. [Local development](#6-local-development)
7. [Observability](#7-observability)
8. [Adding new providers](#8-adding-new-providers)
9. [Security](#9-security)
10. [Adapting for your fork](#10-adapting-for-your-fork)
11. [Troubleshooting](#11-troubleshooting)
12. [See also](#12-see-also)

---

## 1. Why this exists

Sguardo is a local-first app. The vast majority of data flow goes directly from the data provider (CMS / EHR portal / wearable) to the user's device — Sound Prediction's servers are never in the path.

The exception is the initial OAuth handshake. CMS Blue Button 2.0 (and most payer FHIR endpoints) require the client to authenticate the token-exchange request with HTTP Basic Auth using a `client_secret`. A secret shipped in a mobile binary is extractable by anyone with `strings`, so it must live server-side.

This worker is the smallest possible server that satisfies that requirement:

- **Stateless**. No database, no cache, no logs of PHI.
- **One hop**. Only the authorization-code → token swap touches it. After tokens reach the device, the app talks directly to the provider's FHIR API.
- **Single secret per provider**. Stored in Cloudflare's encrypted env vars; never in source.

Public-PKCE providers (Epic MyChart) **don't need this worker** — those apps handle the token exchange directly because no `client_secret` is involved.

---

## 2. Architecture

```
[App on phone] ──opens browser──> api.bluebutton.cms.gov/v2/o/authorize?
                                    client_id=<sguardo>&
                                    redirect_uri=https://oauth.soundprediction.com/bluebutton/callback&
                                    state=<app-generated>&
                                    response_type=code
                                          │
                                          │ user logs in & authorizes
                                          ▼
                                  302 → oauth.soundprediction.com/bluebutton/callback?code=X&state=Y
                                                  │
                                                  ▼
                  [this worker]: POST api.bluebutton.cms.gov/v2/o/token
                                with Basic Auth (BB_CLIENT_ID / BB_CLIENT_SECRET)
                                body: grant_type=authorization_code, code=X, redirect_uri=…
                                                  │
                                                  ▼
                                  302 → sguardo://callback/bluebutton?access_token=…&refresh_token=…&state=…
                                                  │
                                                  ▼
                                  [phone OS launches Sguardo via sguardo:// scheme]
                                                  │
                                                  ▼
                                  [app verifies state, stores tokens locally,
                                   then talks directly to api.bluebutton.cms.gov/v2/fhir
                                   with the bearer token — no relay involved]
```

Token refresh (when the access_token expires after ~1 hour) is also handled directly on-device in the current design — the refresh_token is a long-lived secret that lives only on the user's device, not in this worker. The worker is touched **once per OAuth grant**.

---

## 3. Prerequisites

- **Cloudflare account** — free tier is fine (100k Worker requests/day quota covers any realistic beta load).
- **A domain in Cloudflare DNS** — Sound Prediction uses `soundprediction.com`. The domain doesn't need to be hosted on Cloudflare for everything (the marketing site stays on GitHub Pages); only the `oauth.*` subdomain needs Cloudflare-managed DNS.
- **Node.js 18+** locally for the Wrangler CLI.
- **A CMS Blue Button developer account** at https://bluebutton.cms.gov/ — needed to register sandbox + production redirect URIs. Sandbox access is instant; production requires CMS review.

---

## 4. First-time setup

Run through these once per Cloudflare account. Steps 4.3 and 4.4 are also needed once per environment (staging + production).

### 4.1 Install Wrangler

```bash
cd ~/workspace/glance/sguardo-auth-worker
npm install
npx wrangler login   # opens a browser for OAuth into Cloudflare
```

When the browser confirms login, the CLI prints your account email.

### 4.2 Set your Cloudflare account ID in `wrangler.toml`

```bash
npx wrangler whoami
# copy the "Account ID" value (looks like e6e8...3a4f)
```

Open `wrangler.toml` and replace `account_id = "REPLACE_ME"` with the actual ID.

### 4.3 Provision the DNS + Custom Domain for the worker

This is what makes `oauth.soundprediction.com` actually point at the Worker.

**At your domain registrar** (or wherever `soundprediction.com` DNS is managed):

If `soundprediction.com` is using Cloudflare's nameservers, skip this — Cloudflare handles the records automatically when you set up Custom Domain (step below). If it's on another DNS provider (Route53, GoDaddy, etc.), add these CNAME records:

| Type | Name | Target | TTL |
|---|---|---|---|
| CNAME | `oauth.soundprediction.com` | `sguardo-auth-worker-production.<account-subdomain>.workers.dev` | 300 |
| CNAME | `oauth-staging.soundprediction.com` | `sguardo-auth-worker-staging.<account-subdomain>.workers.dev` | 300 |

Cloudflare gives you the exact target subdomain after the first `wrangler deploy`. Run a no-op deploy first to discover it:

```bash
npx wrangler deploy --env staging --dry-run
```

**In the Cloudflare dashboard** (Workers & Pages → sguardo-auth-worker-production → Triggers → Custom Domains):

- Click **Add Custom Domain**
- Hostname: `oauth.soundprediction.com`
- Cloudflare verifies DNS, provisions a TLS certificate (typically 1–3 minutes), and routes that hostname to the Worker

Repeat for `oauth-staging.soundprediction.com` under the staging Worker.

### 4.4 Set per-environment secrets

Wrangler stores secrets encrypted server-side. They never appear in `wrangler.toml`, source, or logs.

Secrets follow the naming convention `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET` where `<PROVIDER>` is the uppercased path segment (e.g. `BLUEBUTTON`, `HUMANA`, `UNITED`).

**Staging** (sandbox credentials — set only the providers you actually use):

```bash
# CMS Blue Button (sandbox creds from https://sandbox.bluebutton.cms.gov/)
npx wrangler secret put BLUEBUTTON_CLIENT_ID --env staging
npx wrangler secret put BLUEBUTTON_CLIENT_SECRET --env staging

# Humana (when you have a sandbox app at developers.humana.com)
npx wrangler secret put HUMANA_CLIENT_ID --env staging
npx wrangler secret put HUMANA_CLIENT_SECRET --env staging
```

**Production** (only after each provider approves your production application):

```bash
npx wrangler secret put BLUEBUTTON_CLIENT_ID --env production
npx wrangler secret put BLUEBUTTON_CLIENT_SECRET --env production
# ... and so on per provider as their production access is granted
```

Verify what's set without revealing values:

```bash
npx wrangler secret list --env staging
npx wrangler secret list --env production
```

If a provider's secrets aren't set for a given environment, the Worker returns 404 for that provider's callback path. This is intentional — it means "not configured here" without leaking that the path would otherwise be valid.

### 4.5 Register the Worker URLs as redirect URIs with CMS

Go to https://bluebutton.cms.gov/ → Developer Dashboard → your application → Edit.

Under **Authorized Redirect URIs**, add (exact strings, no trailing slashes):

- For your sandbox app: `https://oauth-staging.soundprediction.com/bluebutton/callback`
- For your production app: `https://oauth.soundprediction.com/bluebutton/callback`

CMS rejects mismatched URIs at OAuth time — even a trailing slash difference is a hard fail. Match `BB_REDIRECT_URI` in `wrangler.toml` byte-for-byte.

---

## 5. Deploy + test

### 5.1 Deploy

```bash
# Push the worker bundle to Cloudflare's edge.
npm run deploy:staging      # → oauth-staging.soundprediction.com
npm run deploy:production   # → oauth.soundprediction.com (only after CMS production approval)
```

Wrangler prints the deploy URL and version hash. Versions are kept; you can roll back via `wrangler rollback`.

### 5.2 Smoke test the deployed Worker

Without going through a full OAuth flow, you can verify the Worker is reachable and routing correctly:

```bash
# Should return 400 (no code/state) — but confirms TLS + routing work.
curl -sI "https://oauth-staging.soundprediction.com/bluebutton/callback"

# Should return 404 — confirms unknown paths are rejected.
curl -sI "https://oauth-staging.soundprediction.com/random"

# Should return 302 with Location pointing to sguardo://callback/bluebutton?error=...
curl -sI "https://oauth-staging.soundprediction.com/bluebutton/callback?error=access_denied&state=test"
```

If those pass, the Worker is healthy.

### 5.3 End-to-end OAuth test against sandbox

Run the full flow from a real phone (or `flutter run` on a connected device — the simulator works too if `app_links` is configured to handle the `sguardo://` scheme on simulator):

1. In the Sguardo app: **Sources → Connect Blue Button**
2. Browser opens at `https://sandbox.bluebutton.cms.gov/v2/o/authorize?...` — log in with one of CMS's sample synthetic beneficiaries (https://sandbox.bluebutton.cms.gov/testclient/authorize-link-v2 lists them)
3. CMS prompts to authorize; click **Allow**
4. Browser briefly shows the Worker URL, then redirects to `sguardo://callback/bluebutton?access_token=...`
5. The Sguardo app handles the deep link, completes the flow, and shows the connection as **Connected** on the Sources screen

If step 4 doesn't auto-redirect (some Android browsers block scheme handoffs), the static fallback at https://soundprediction.com/sguardo/callback/bluebutton/ catches it — but in this architecture you'd never see that page because CMS redirects to the Worker, not to soundprediction.com.

---

## 6. Local development

For iterating on the Worker code without redeploying:

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your sandbox creds (file is gitignored).

npm run dev    # serves on http://127.0.0.1:8787
```

Send a fake callback to verify the redirect target shape:

```bash
curl -i "http://127.0.0.1:8787/bluebutton/callback?code=fake&state=test"
```

The response should be a `302` with `Location: sguardo://callback/bluebutton?...` — `access_token` may be empty if CMS rejects the fake code, but the redirect structure is what matters here.

To run against the actual CMS sandbox endpoint, paste a real authorization code (intercept one from the browser address bar during a manual OAuth flow). Codes are single-use and expire in ~30 seconds.

---

## 7. Observability

```bash
# Live tail of the deployed Worker's logs (sampled — not full traffic).
npm run tail:staging
npm run tail:production
```

The Worker logs only metadata:

- HTTP status codes
- Error categories (e.g. `token_exchange_failed`)
- Body lengths (for failed exchanges, to estimate how detailed the CMS error response was)

It **does not** log:
- Authorization codes
- Access tokens
- Refresh tokens
- Patient IDs
- Request bodies
- Response bodies

That's intentional. If you ever need to add logging while debugging, **never log token bodies or response payloads** even briefly — logs in Cloudflare can persist longer than you intend in cached views.

Cloudflare's Workers Analytics dashboard (Workers & Pages → your worker → Metrics) shows req/sec, error rates, and CPU usage. No PHI is visible there.

---

## 8. Adding new providers

The Worker is config-driven: adding a new provider that already conforms to RFC 6749 §4.1.3 (authorization-code grant with HTTP Basic Auth on the token endpoint) is just data — no per-provider Worker code.

### 8.1 Add the provider's path to the registry

In `src/index.ts`, add to the `PROVIDERS` array:

```typescript
const PROVIDERS = [
  "bluebutton",
  "humana",
  // ...
  "your_new_provider",  // path segment becomes /your_new_provider/callback
] as const;
```

The path segment is the lowercased provider name; the env-var prefix is the same name uppercased.

### 8.2 Add token URL + redirect URI to `wrangler.toml`

For each environment (production + staging):

```toml
[env.production.vars]
YOUR_NEW_PROVIDER_TOKEN_URL    = "https://api.provider.com/oauth2/token"
YOUR_NEW_PROVIDER_REDIRECT_URI = "https://oauth.soundprediction.com/your_new_provider/callback"
```

### 8.3 Set client credentials as encrypted secrets

```bash
npx wrangler secret put YOUR_NEW_PROVIDER_CLIENT_ID --env production
npx wrangler secret put YOUR_NEW_PROVIDER_CLIENT_SECRET --env production
```

### 8.4 Register the redirect URI with the provider

Same pattern as CMS — the URI must match `YOUR_NEW_PROVIDER_REDIRECT_URI` byte-for-byte.

### 8.5 Wire the app side

On the Flutter app side, ensure `app_links` handles `sguardo://callback/your_new_provider`:
- Android: add an `<intent-filter>` for the scheme + path in `AndroidManifest.xml`
- iOS: `CFBundleURLTypes` in `Info.plist` already covers any `sguardo://` path

The existing `OAuthCallbackHandler` routes by path segment.

### 8.6 Deploy + verify

```bash
npm run deploy:production
curl -i "https://oauth.soundprediction.com/your_new_provider/callback?error=test&state=x"
# Should return 302 → sguardo://callback/your_new_provider?error=test&state=x
```

If secrets aren't set, the curl returns 404 (intentional — the provider is in the allowlist but not configured for this environment).

### 8.7 When NOT to use this Worker

Providers that support **public-PKCE OAuth** (no `client_secret`) — e.g. Epic MyChart — should NOT route through here. The native app completes their token exchange directly with PKCE `code_verifier`/`code_challenge`. Don't add them to `PROVIDERS`.

Use this Worker only when the provider's OAuth registration says "confidential client" or requires HTTP Basic Auth with `client_secret` on the token endpoint.

---

## 9. Security

| Surface | Mitigation |
|---|---|
| Secret leakage | Secrets live only in Cloudflare's encrypted env var store. Never in `wrangler.toml`, source, build artifacts, or logs. Verified by `wrangler secret list` only returning names, not values. |
| Log leakage | Worker logs status codes and category labels only. Token bodies, codes, PHI never appear. |
| TLS downgrade | Cloudflare's edge enforces TLS 1.2+; no plaintext path exists. |
| Replay attacks | OAuth `state` parameter is generated by the app, included in the authorize request, and verified after the Worker's deep-link redirect. The Worker passes `state` through verbatim — it doesn't trust or generate it. |
| Open redirector | The Worker only redirects to the hardcoded `sguardo://` scheme; not configurable via query params. |
| Code signing | Worker code is open source. Verify deployment integrity by comparing `git rev-parse HEAD` to the version hash printed by `wrangler deploy`. |
| Multi-tenant exposure | Cloudflare Workers run in isolated V8 sandboxes per request. No shared state between requests beyond what your code explicitly stores. |

See `sguardo-patient/docs/SECURITY_INCIDENT_RESPONSE.md` for the response plan if a secret is exposed.

---

## 10. Adapting for your fork

If you're not Sound Prediction and you're shipping your own build of Sguardo (or a derivative app) to your own App Store / Play Store account, you'll need your own Worker deployment with your own redirect URIs and your own CMS BB2 production application.

### What you need to change

| Constant | Where | Replace with |
|---|---|---|
| `oauth.soundprediction.com` and `oauth-staging.soundprediction.com` | `wrangler.toml`, this README, your CMS app registration | Your domain's OAuth subdomain (e.g. `oauth.example.com`) |
| `sguardo://callback/<provider>` | `src/index.ts` (APP_SCHEME constant) | Your app's custom URL scheme |
| `developers@soundprediction.com` | This README | Your contact email |
| CMS BB2 client_id / client_secret | Cloudflare encrypted env vars | Your own CMS-issued credentials — never reuse Sound Prediction's |

### What you cannot reuse

- **CMS Blue Button credentials** — they're tied to Sound Prediction's CMS application registration. Apply for your own at https://bluebutton.cms.gov/. Apple Developer Team IDs work the same way; each org has its own.
- **The deployed Worker** at `oauth.soundprediction.com` — that's Sound Prediction's production instance with Sound Prediction's CMS secrets. Even if Cloudflare lets you deploy under that same domain (they wouldn't — you don't own the DNS), your CMS app's `redirect_uri` wouldn't match.

### What you can reuse

- This entire Worker source code (MIT or whatever license this repo eventually publishes under)
- The architectural pattern
- The Wrangler config layout (just change names + redirect URIs)
- The CMS application boilerplate in `sguardo-patient/docs/SECURITY_INCIDENT_RESPONSE.md` (adapt the contacts)

### Things to never copy verbatim from upstream

- `account_id` in `wrangler.toml` (yours is different)
- The CMS contact prose in incident-response docs (yours should reflect your team)
- The wording in your own CMS production application — write it about your own deployment

---

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `wrangler deploy` fails with "Authentication required" | Not logged in | `npx wrangler login` |
| `wrangler deploy` fails with "Couldn't find an account ID" | `account_id` placeholder in `wrangler.toml` | `npx wrangler whoami`, paste real ID into `wrangler.toml` |
| Cloudflare dashboard says "Custom Domain is Pending DNS" | CNAME not yet propagated, or wrong target | `dig oauth.soundprediction.com CNAME` should return Cloudflare's target. Wait 5 min, then click "Refresh" in CF dashboard. |
| OAuth flow on phone redirects to a 404 page | `redirect_uri` registered with CMS doesn't match `BB_REDIRECT_URI` in `wrangler.toml` | Compare both strings character-by-character; even trailing slash matters |
| Worker returns 500 on real callback but works in `curl` | Probably a `wrangler secret` missing for the active env | `npx wrangler secret list --env production` should show `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET` for every provider you've registered. If a provider's secrets aren't set, the Worker returns 404 for its path rather than 500 — so 500 means a real error mid-handler. |
| Worker returns 404 for a provider's callback | Either the provider isn't in the `PROVIDERS` array, or its env vars aren't set for this environment | Check `src/index.ts` includes the provider name; check `wrangler secret list --env <env>` shows the 2 secrets; check `wrangler.toml` has the 2 vars |
| `sguardo://` link doesn't open the app | The phone doesn't have Sguardo installed, OR `app_links` isn't registered for the scheme | Check `ios/Runner/Info.plist` CFBundleURLTypes contains `sguardo`; check Android `intent-filter` for `android:scheme="sguardo"` in `AndroidManifest.xml` |
| Browser stays on the Worker URL and never redirects | Worker exception (check `wrangler tail`) | Tail logs, find the exception, deploy a fix |
| Worker returns `token_exchange_failed` | CMS rejected the exchange (expired code, wrong client_secret, wrong redirect_uri) | Codes expire in ~30 seconds. Verify the secret in Wrangler. If still failing, check CMS's developer dashboard for app status. |
| CMS returns `redirect_uri_mismatch` during authorize | The authorize URL the app sent has a different `redirect_uri` than what's registered | The app's OAuth flow code constructs the authorize URL. Check `sguardo/pkg/medicare/bluebutton/auth/auth.go` for how it builds the URL. |

If `wrangler tail` shows the Worker is hit but the redirect isn't landing in the app, the issue is on the OS / `app_links` side, not the Worker. The 302 response in `curl -i` should look like:

```
HTTP/2 302
location: sguardo://callback/bluebutton?state=…&access_token=…
```

If `location` looks right, the Worker is doing its job.

---

## 12. See also

- **`sguardo/config/fhir_sources.example.toml`** — the source-of-truth template for FHIR source URLs and the redirect URIs used in the app
- **`sguardo/pkg/medicare/bluebutton/auth/auth.go`** — native-side BB2 OAuth flow code that the Worker complements
- **`sguardo-patient/docs/APPLE_APP_STORE.md`** — App Store + signing pipeline
- **`sguardo-patient/docs/STORE_SETUP.md`** — Play Console + App Store Connect listing setup
- **`sguardo-patient/docs/SECURITY_INCIDENT_RESPONSE.md`** — incident response plan referenced by the CMS production application
- **CMS Blue Button 2.0 docs** — https://bluebutton.cms.gov/developers
- **Cloudflare Workers docs** — https://developers.cloudflare.com/workers/
