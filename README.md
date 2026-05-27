# sguardo-auth-worker

Cloudflare Worker that handles the **OAuth authorization-code → access-token exchange** for FHIR data providers that require confidential clients (currently CMS Blue Button 2.0; other payers will be added).

## Why this exists

Sguardo is a local-first app. The vast majority of data flow goes directly from the data provider (CMS / EHR portal / wearable) to the user's device — Sound Prediction's servers are never in the path.

The exception is the initial OAuth handshake. CMS Blue Button 2.0 (and most payer FHIR endpoints) require the client to authenticate the token-exchange request with HTTP Basic Auth using a `client_secret`. A secret shipped in a mobile binary is extractable by anyone with `strings`, so it must live server-side.

This worker is the smallest possible server that satisfies that requirement:

- **Stateless**. No database, no cache, no logs of PHI.
- **One hop**. Only the authorization-code → token swap touches it. After tokens reach the device, the app talks directly to the provider's FHIR API.
- **Single secret per provider**. Stored in Cloudflare's encrypted env vars; never in source.

## Architecture

```
[App on phone] ──opens browser──> api.bluebutton.cms.gov/v2/o/authorize?...
                                          │
                                          │ user logs in & authorizes
                                          ▼
                                  302 → oauth.soundprediction.com/bluebutton/callback?code=X&state=Y
                                                  │
                                                  ▼
                          [this worker]: POST api.bluebutton.cms.gov/v2/o/token
                                          with Basic Auth (BB_CLIENT_SECRET)
                                                  │
                                                  ▼
                                  302 → sguardo://callback/bluebutton?access_token=…&refresh_token=…&state=…
                                                  │
                                                  ▼
                                  [phone OS launches Sguardo via sguardo:// scheme]
                                                  │
                                                  ▼
                                  [app stores tokens locally; future FHIR calls go direct to CMS]
```

## Deploy

### One-time setup

1. Install Cloudflare's Wrangler CLI:
   ```bash
   npm install
   npx wrangler login
   ```
2. Get your Cloudflare account ID (`wrangler whoami`) and paste it into `wrangler.toml`.
3. Add `oauth.soundprediction.com` and `oauth-staging.soundprediction.com` as **Custom Domains** in the Cloudflare dashboard for the worker (Workers & Pages → sguardo-auth-worker → Triggers → Custom Domains). Cloudflare provisions TLS automatically.
4. Set production secrets:
   ```bash
   npx wrangler secret put BB_CLIENT_ID --env production
   npx wrangler secret put BB_CLIENT_SECRET --env production
   ```
   And staging:
   ```bash
   npx wrangler secret put BB_CLIENT_ID --env staging
   npx wrangler secret put BB_CLIENT_SECRET --env staging
   ```

### Ship

```bash
npm run deploy:staging      # oauth-staging.soundprediction.com
npm run deploy:production   # oauth.soundprediction.com
```

### Watch logs (sampled, no PHI)

```bash
npm run tail:production
```

## Local dev

```bash
cp .dev.vars.example .dev.vars    # then edit with sandbox creds
npm run dev                       # serves on http://127.0.0.1:8787
```

Send a fake callback to test:

```bash
curl -i "http://127.0.0.1:8787/bluebutton/callback?code=test_code&state=test_state"
```

The response will be a 302 to a `sguardo://` URL — copy the body to verify shape (the actual phone obviously isn't involved in dev).

## CMS production registration

The `redirect_uri` registered with CMS at https://bluebutton.cms.gov/production-access/ **must** match `BB_REDIRECT_URI` byte-for-byte:

- Production: `https://oauth.soundprediction.com/bluebutton/callback`
- Sandbox: `https://oauth-staging.soundprediction.com/bluebutton/callback`

CMS rejects mismatched URIs (even trailing-slash differences). Sandbox can register on day one; production gets registered after CMS approves the app for production access.

## Adding new providers

To extend to e.g. Humana payer access:

1. Add `HUMANA_CLIENT_ID`, `HUMANA_CLIENT_SECRET`, `HUMANA_REDIRECT_URI` to `Env` and the wrangler config.
2. Add `humana` to the `providerFromPath()` and `configFor()` switches.
3. The handler logic is identical; the only per-provider differences are the token URL and any vendor-specific query params.

Public-PKCE providers (e.g. Epic MyChart) **don't need this worker** — the app handles the token exchange directly because no `client_secret` is involved. Skip those.

## Security

- Secrets live only in Cloudflare's encrypted env vars. They never appear in source, build artifacts, or logs.
- The worker logs only status codes and metadata, never request/response bodies.
- TLS is enforced by Cloudflare's edge — no plaintext path exists.
- Worker code is open source. Verify what's running by comparing the deployed bundle hash to the `git rev-parse HEAD` at deploy time.

## See also

- `sguardo-patient/docs/APPLE_APP_STORE.md` — App Store submission walkthrough
- `sguardo/pkg/medicare/bluebutton/auth/auth.go` — corresponding native-side OAuth flow code
- `sguardo-patient/docs/SECURITY_INCIDENT_RESPONSE.md` — incident response plan (referenced by CMS production application)
