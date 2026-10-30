import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { isKnownTunnelHost } from "@/lib/auth/tunnelAccess";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

// Constant-time equality for hex-string secrets (S1): a plain === compare
// leaks prefix match timing on the token boundary.
function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return timingSafeEqualHex(token, await getCliToken());
}

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/setup-password", // self-gated: fresh install + default password + one-time setup code + rate limit
  "/api/auth/oidc",
  "/api/auth/saml",
  "/api/version",
  "/api/settings/require-login",
];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
// Keep root-level rewrites here too: middleware runs before Next.js rewrites.
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
  "/api/oauth/minimax-code/lease",
  "/api/oauth/minimax-code-global/lease",
];

// Require auth, but allow through if requireLogin is disabled
const PROTECTED_API_PATHS = [
  "/api/settings",
  "/api/keys",
  "/api/providers",
  "/api/provider-nodes",
  "/api/proxy-pools",
  "/api/combos",
  "/api/models",
  "/api/usage",
  "/api/oauth",
  "/api/cloud",
  "/api/media-providers",
  "/api/pricing",
  "/api/tags",
  "/api/cli-tools",
  "/api/mcp",
  "/api/translator",
  "/api/tunnel",
  "/api/xray/status",
  "/api/xray/configs",
  "/api/xray/logs",
  "/api/xray/sync",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/oauth/zed/auto-import",
  "/api/oauth/minimax-code/lease",
  "/api/oauth/minimax-code-global/lease",
  "/api/auth/reset-password",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
  "/api/ds2api/install",
  "/api/ds2api/start",
  "/api/ds2api/stop",
  "/api/xray/install",
  "/api/xray/subscriptions", // FORK (multi-sub): stores token-bearing URLs, triggers egress
  "/api/xray/sync",          // FORK (multi-sub): triggers server-side egress
  "/api/xray/start",
  "/api/xray/stop",
  "/api/xray/restart",
  "/api/xray/switch",
  "/api/xray/health-check",
  "/api/xray/configs/", // covers /api/xray/configs/[id]/test (spawns xray)
];

// Subset of LOCAL_ONLY_PATHS that stay loopback-only even when the user opts
// into tunnel dashboard access. These routes read host secrets or leak the CLI
// token in their response, so allowing them over a tunnel would hand a remote
// attacker (who has stolen/guessed the dashboard password) the ability to reset
// the password or harvest the machine-id token.
const STRICT_LOCAL_ONLY = [
  "/api/auth/reset-password",
  "/api/cli-tools/cowork-settings",
];

// Locality helpers now live in lib/auth/requestLocality.js (shared with
// dashboardSession's re-auth gate). Imported for local use and re-exported
// for existing consumers.
import { isLocalRequest, isLoopbackHostname, hostnameFromHeader, isPrivateNetworkHostname } from "@/lib/auth/requestLocality.js";
export { isLocalRequest, isLoopbackHostname };

async function canAccessFromPrivateDashboard(request) {
  // Direct authenticated dashboard access over a private LAN IP should be able
  // to run host-local tools such as Xray start/stop. Require a real JWT and a
  // same-origin browser request so disabling dashboard login does not expose
  // process-spawning APIs to the whole LAN.
  if (request.headers.get("x-9r-via-proxy")) return false;
  const host = hostnameFromHeader(request.headers.get("host"));
  if (!isPrivateNetworkHostname(host)) return false;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    if (new URL(origin).hostname.toLowerCase() !== host) return false;
  } catch {
    return false;
  }
  return await hasValidToken(request);
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  return request.nextUrl.searchParams?.get("key") || null;
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

async function canAccessLocalOnlyRoute(request, pathname) {
  if (await hasValidCliToken(request)) return true;
  // Browser on host: loopback Host + Origin (blocks tunnel/CSRF) + auth (JWT or requireLogin=false)
  if (isLocalRequest(request) && await isAuthenticated(request)) return true;

  // Strict routes (host secrets / CLI-token leakage) never open over a tunnel,
  // even when the user has opted into tunnel dashboard access.
  if (STRICT_LOCAL_ONLY.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return false;
  }

  if (await canAccessFromPrivateDashboard(request)) return true;

  // Tunnel access: user must have explicitly enabled "Allow dashboard access via
  // tunnel", the request must come from a recognized tunnel host, and the user
  // must be authenticated. Lets ds2api install/start/stop etc. work over a
  // tunnel (incl. cloudflared run via systemd) without exposing host secrets.
  const settings = await loadSettings();
  if (settings && settings.tunnelDashboardAccess === true && isKnownTunnelHost(request, settings)) {
    return await isAuthenticated(request);
  }
  return false;
}

async function hasValidToken(request) {
  const token = request.cookies.get("auth_token")?.value;
  return await verifyDashboardAuthToken(token);
}

// Read settings directly from DB to avoid self-fetch deadlock in proxy
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Shared with src/proxy.js — the mimo login branch must respect dashboard auth.
export { isAuthenticated };

export const __test__ = {
  isLocalRequest,
  isPublicLlmApi,
  extractApiKey,
  canAccessPublicLlmApi,
  canAccessLocalOnlyRoute,
};

export async function proxy(request) {
  const { pathname } = request.nextUrl;

  // Local-only gate for spawn-capable / host-secret routes.
  if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
    if (!(await canAccessLocalOnlyRoute(request, pathname))) {
      return NextResponse.json({ error: "Local only: CLI token required" }, { status: 403 });
    }
  }

  // Always protected - require valid JWT or local CLI token (machineId-based)
  if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
    if (await hasValidCliToken(request) || await hasValidToken(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (isPublicLlmApi(pathname)) {
    if (await canAccessPublicLlmApi(request)) return NextResponse.next();
    return NextResponse.json({ error: "API key required for remote API access" }, { status: 401 });
  }

  // Deny-by-default for /api/* — public allow-list bypasses, everything else requires auth.
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) return NextResponse.next();
    if (await hasValidCliToken(request) || await isAuthenticated(request))
      return NextResponse.next();
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Protect all dashboard routes
  if (pathname.startsWith("/dashboard")) {
    let requireLogin = true;
    let tunnelDashboardAccess = false; // fail-closed when settings can't load

    try {
      const settings = await loadSettings();
      if (settings) {
        requireLogin = settings.requireLogin !== false;
        tunnelDashboardAccess = settings.tunnelDashboardAccess === true;

        // Block tunnel/tailscale access if disabled (redirect to login).
        // Recognizes app-managed tunnels plus externalTunnelUrl (cloudflared via systemd etc.)
        if (!tunnelDashboardAccess && isKnownTunnelHost(request, settings)) {
          return NextResponse.redirect(new URL("/login", request.url));
        }
      }
    } catch {
      // On error, keep defaults (require login, block tunnel)
    }

    // If login not required, allow through
    if (!requireLogin) return NextResponse.next();

    // Verify JWT token
    const token = request.cookies.get("auth_token")?.value;
    if (token) {
      if (await verifyDashboardAuthToken(token)) {
        return NextResponse.next();
      } else {
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }

    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Redirect / to /dashboard if logged in, or /dashboard if it's the root
  if (pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}
