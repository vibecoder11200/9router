import { getSettings } from "@/lib/localDb";
import { DEFAULT_DS2API_URL } from "@/lib/ds2api/detect";
import { getManagedPid } from "@/lib/ds2api/process";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Auth-gated (via dashboardGuard PROTECTED_API_PATHS) streaming reverse proxy to the
// internal DS2API sidecar. Keeps the sidecar port unexposed; 9router users reach raw
// ds2api endpoints (health, admin API, static) through here.
//
// Note: ds2api's React webui uses absolute /admin/* asset paths, so embedding it behind
// this /api/ds2api/proxy prefix is imperfect without HTML rewriting. Primary account
// management is the native 9router UI; this proxy is for advanced/raw authenticated access.

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer",
  "host", "content-length", "upgrade",
]);

function forwardedHeaders(src) {
  const out = {};
  for (const [k, v] of src.entries()) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function proxy(request, { params }) {
  const settings = await getSettings();
  const base = String(settings.ds2apiUrl || DEFAULT_DS2API_URL).replace(/\/$/, "");
  const { path } = await params;
  const segments = Array.isArray(path) ? path : [path].filter(Boolean);
  const url = `${base}/${segments.join("/")}${request.nextUrl?.search || ""}`;

  // Don't forward to a sidecar we're not managing/running — avoids hitting an unknown host.
  if (!getManagedPid()) {
    return new Response(JSON.stringify({ error: "DS2API sidecar is not running" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const init = {
    method: request.method,
    headers: forwardedHeaders(request.headers),
  };
  if (!["GET", "HEAD"].includes(request.method)) init.body = request.body;
  // duplexer: let fetch stream the request body for non-buffered POSTs

  const upstream = await fetch(url, init).catch((e) => ({
    status: 502,
    ok: false,
    text: async () => JSON.stringify({ error: `proxy fetch failed: ${e.message}` }),
    headers: new Headers({ "Content-Type": "application/json" }),
  }));

  const respHeaders = new Headers();
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders.set(k, v);
  });

  return new Response(upstream.body ?? await upstream.text(), {
    status: upstream.status,
    headers: respHeaders,
  });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as DELETE, proxy as PATCH, proxy as OPTIONS };
