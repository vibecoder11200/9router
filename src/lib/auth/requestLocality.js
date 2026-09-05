// Request-locality helpers shared by the dashboard guard and re-auth paths.
// Extracted from dashboardGuard so dashboardSession can gate the default
// password without importing the guard (circular import).

import { hasTrustedPeerHeaders } from "./trustedPeer.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// Accepts a Host header, a URL hostname or a raw socket address. Splitting on the first
// colon only works for IPv4 and would reduce every IPv6 form to "", so a dual-stack
// listener handing back ::ffff:127.0.0.1 would not read as loopback.
export function isLoopbackHostname(h) {
  if (!h) return false;
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return false;
    name = name.slice(1, end);
  } else if (name.indexOf(":") !== -1 && name.indexOf(":") === name.lastIndexOf(":")) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) {
    // IPv4-mapped IPv6 comes in two textual forms: dotted ("::ffff:127.0.0.1",
    // which strips to "127.0.0.1" below) and hex ("::ffff:7f00:1", which Node's
    // URL parser can emit). Expand the hex form's embedded IPv4 tail.
    const rest = name.slice(7);
    const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return `${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}` === "127.0.0.1";
    }
    name = rest;
  }
  return LOOPBACK_HOSTS.has(name);
}

function hostnameFromHeader(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end >= 0 ? raw.slice(1, end) : raw.slice(1);
  }
  const colonCount = (raw.match(/:/g) || []).length;
  return colonCount === 1 ? raw.split(":")[0] : raw;
}

function isPrivateNetworkHostname(h) {
  const name = hostnameFromHeader(h);
  const parts = name.split(".").map((p) => Number(p));
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return name.startsWith("fc") || name.startsWith("fd") || name.startsWith("fe80:");
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-9r-real-ip"));
  }
  // Bare `next dev` forks its server, so the wrapper never loads and no peer address
  // reaches us. Host is spoofable, so this stays confined to development.
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

export function isLocalRequest(request) {
  // Stamped by custom-server.js when forwarding headers exist: request came through
  // a reverse proxy, so the loopback socket is the proxy hop, not the end-user.
  if (request.headers.get("x-9r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch { return false; }
  }
  return true;
}

export { hostnameFromHeader, isPrivateNetworkHostname };
