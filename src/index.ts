// OAuth code → token exchange relay for FHIR (and FHIR-adjacent) providers
// that require confidential clients. Hosts the client_secret server-side so
// it never ships to phones, then 302s the OS into the native Sguardo app via
// the sguardo:// URL scheme.
//
// Stateless. No PHI is logged, persisted, or proxied beyond the single hop.
// Only the initial code → token swap touches this worker; subsequent FHIR
// requests go directly from the app to the provider with the stored token.
//
// Public-PKCE providers (e.g. Epic MyChart) DO NOT go through this worker —
// those flows complete the token exchange directly on the device.

// -----------------------------------------------------------------------------
// Provider registry
// -----------------------------------------------------------------------------
//
// Add a provider here once it's known to require confidential-client OAuth and
// is wired up on the app side. Adding a provider here is a no-op until the
// matching env vars (<PROVIDER>_CLIENT_ID, <PROVIDER>_CLIENT_SECRET,
// <PROVIDER>_TOKEN_URL, <PROVIDER>_REDIRECT_URI) are configured for at least
// one environment; the worker returns 404 until that's done.

const PROVIDERS = [
  // CMS Medicare
  "bluebutton",
  // Payers (confidential clients per their developer-portal registration)
  "humana",
  "united",
  "anthem",
  "aetna",
  "cigna",
  "kaiser",
  "centene",
  "molina",
  // Labs
  "quest",
  "labcorp",
  // Other providers can be added as needed; see README §8.
] as const;
type Provider = (typeof PROVIDERS)[number];

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const APP_SCHEME = "sguardo";

type Env = Record<string, string | undefined>;

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  redirectUri: string;
  appCallbackPath: string;
}

function providerFromPath(pathname: string): Provider | null {
  // Strip query string if present.
  const path = pathname.split("?", 1)[0];
  for (const p of PROVIDERS) {
    if (path === `/${p}/callback`) return p;
  }
  return null;
}

function configFor(env: Env, provider: Provider): ProviderConfig | null {
  const upper = provider.toUpperCase();
  const clientId = env[`${upper}_CLIENT_ID`];
  const clientSecret = env[`${upper}_CLIENT_SECRET`];
  const tokenUrl = env[`${upper}_TOKEN_URL`];
  const redirectUri = env[`${upper}_REDIRECT_URI`];
  if (!clientId || !clientSecret || !tokenUrl || !redirectUri) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    tokenUrl,
    redirectUri,
    appCallbackPath: `/callback/${provider}`,
  };
}

// -----------------------------------------------------------------------------
// Redirect helpers
// -----------------------------------------------------------------------------

function deepLink(path: string, params: URLSearchParams): string {
  return `${APP_SCHEME}://${path.replace(/^\//, "")}?${params.toString()}`;
}

function redirectToApp(path: string, params: URLSearchParams): Response {
  // 302 to the custom URL scheme. iOS Safari and Chrome on both platforms
  // honor this and hand off to the app's registered scheme handler.
  return Response.redirect(deepLink(path, params), 302);
}

// -----------------------------------------------------------------------------
// OAuth handlers
// -----------------------------------------------------------------------------

async function handleCallback(req: Request, env: Env, provider: Provider): Promise<Response> {
  const cfg = configFor(env, provider);
  if (!cfg) {
    // Provider is in the allowlist but not configured for this environment.
    // Return 404 to avoid leaking that the path is otherwise valid.
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    const params = new URLSearchParams({ error });
    if (errorDescription) params.set("error_description", errorDescription);
    if (state) params.set("state", state);
    return redirectToApp(cfg.appCallbackPath, params);
  }
  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  // Exchange the authorization code for tokens. Standard RFC 6749 §4.1.3 body
  // with HTTP Basic Auth for the confidential client_id/client_secret. Every
  // major payer's OAuth 2.0 implementation accepts this shape.
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });

  let tokenRes: Response;
  try {
    tokenRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + btoa(`${cfg.clientId}:${cfg.clientSecret}`),
        Accept: "application/json",
      },
      body: tokenBody,
    });
  } catch (err) {
    // Network-level failure reaching the provider. Don't expose internals.
    console.error(`${provider} token endpoint unreachable: ${String(err)}`);
    const params = new URLSearchParams({
      error: "provider_unreachable",
      state,
    });
    return redirectToApp(cfg.appCallbackPath, params);
  }

  if (!tokenRes.ok) {
    // Log status + body length only — body may contain provider error text
    // that's safe in their docs but not safe to write to Cloudflare logs.
    const body = await tokenRes.text();
    console.error(
      `${provider} token exchange failed: status=${tokenRes.status} bodyLength=${body.length}`,
    );
    const params = new URLSearchParams({
      error: "token_exchange_failed",
      error_description: `Provider returned ${tokenRes.status}`,
      state,
    });
    return redirectToApp(cfg.appCallbackPath, params);
  }

  // Forward every field the provider returned. Most return access_token,
  // expires_in, token_type, refresh_token, scope. CMS BB2 also returns
  // `patient`. SMART-on-FHIR providers may return `id_token`. Pass everything
  // through verbatim — the app decides what to use.
  const tokens = (await tokenRes.json()) as Record<string, unknown>;
  const params = new URLSearchParams({ state });
  for (const [key, value] of Object.entries(tokens)) {
    if (value === null || value === undefined) continue;
    params.set(key, typeof value === "string" ? value : String(value));
  }

  return redirectToApp(cfg.appCallbackPath, params);
}

// -----------------------------------------------------------------------------
// Worker entrypoint
// -----------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const provider = providerFromPath(url.pathname);
    if (!provider) {
      return new Response("Not found", { status: 404 });
    }
    if (req.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    try {
      return await handleCallback(req, env, provider);
    } catch (err) {
      console.error(`unhandled error in ${provider} callback: ${String(err)}`);
      return new Response("Internal error", { status: 500 });
    }
  },
};
