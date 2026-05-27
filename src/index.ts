// OAuth code → token exchange relay for FHIR providers that require
// confidential clients. Hosts the client_secret server-side so it never ships
// to phones, then 302s the OS into the native Sguardo app via sguardo:// scheme.
//
// Stateless. No PHI is logged, persisted, or proxied beyond the single hop.
// Only the initial code → token swap touches this worker; subsequent FHIR
// requests go directly from the app to the provider with the stored token.

interface Env {
  // CMS Blue Button 2.0 (Medicare)
  BB_CLIENT_ID: string;
  BB_CLIENT_SECRET: string;
  BB_REDIRECT_URI: string; // must exactly match what's registered with CMS

  // Optional: allowlist of state strings that the worker will accept.
  // Not enforced by default — the app generates the state and verifies it
  // post-callback, so cross-site reuse is already blocked at the app layer.
}

type ProviderConfig = {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  redirectUri: string;
  // App-side scheme path; must match the AppLinks handler in the Flutter app.
  appCallbackPath: string;
};

const APP_SCHEME = "sguardo";

function providerFromPath(pathname: string): "bluebutton" | null {
  if (pathname.startsWith("/bluebutton/callback")) return "bluebutton";
  return null;
}

function configFor(env: Env, provider: "bluebutton"): ProviderConfig {
  switch (provider) {
    case "bluebutton":
      return {
        clientId: env.BB_CLIENT_ID,
        clientSecret: env.BB_CLIENT_SECRET,
        tokenUrl: "https://api.bluebutton.cms.gov/v2/o/token/",
        redirectUri: env.BB_REDIRECT_URI,
        appCallbackPath: "/callback/bluebutton",
      };
  }
}

function deepLink(path: string, params: URLSearchParams): string {
  return `${APP_SCHEME}://${path.replace(/^\//, "")}?${params.toString()}`;
}

function redirectToApp(path: string, params: URLSearchParams): Response {
  // 302 to the custom URL scheme. iOS Safari and Chrome on both platforms
  // honor this and hand off to the app's registered scheme handler.
  return Response.redirect(deepLink(path, params), 302);
}

async function handleCallback(req: Request, env: Env, provider: "bluebutton"): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  const cfg = configFor(env, provider);

  if (error) {
    const params = new URLSearchParams({ error });
    if (errorDescription) params.set("error_description", errorDescription);
    if (state) params.set("state", state);
    return redirectToApp(cfg.appCallbackPath, params);
  }
  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  // Exchange the authorization code for tokens. CMS BB2 requires HTTP Basic
  // Auth with the confidential client_id/client_secret.
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
  });

  const tokenRes = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${cfg.clientId}:${cfg.clientSecret}`),
      Accept: "application/json",
    },
    body: tokenBody,
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    const params = new URLSearchParams({
      error: "token_exchange_failed",
      error_description: `Provider returned ${tokenRes.status}`,
      state,
    });
    // Log only metadata, never the body which may contain partial PHI.
    console.error(
      `${provider} token exchange failed: status=${tokenRes.status} bodyLength=${body.length}`,
    );
    return redirectToApp(cfg.appCallbackPath, params);
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    patient?: string;
  };

  const params = new URLSearchParams({
    state,
    access_token: tokens.access_token ?? "",
    refresh_token: tokens.refresh_token ?? "",
    token_type: tokens.token_type ?? "Bearer",
    expires_in: String(tokens.expires_in ?? ""),
    scope: tokens.scope ?? "",
    patient: tokens.patient ?? "",
  });

  return redirectToApp(cfg.appCallbackPath, params);
}

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
