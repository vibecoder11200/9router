/**
 * V2Ray share-link → Xray-core outbound JSON parser.
 *
 * Faithful JavaScript port of v2go's internal/converter/converter.go
 * (https://github.com/Danialsamadi/v2go). The Go original is the source of
 * truth for field semantics; any divergence is noted inline.
 *
 * Supported protocols: vless, vmess, ss (shadowsocks), trojan, hysteria2.
 * Each parser returns an Xray "outbound" object shaped as:
 *   { protocol, tag:"proxy", settings, streamSettings }
 *
 * The conversion is value-exact: no defaults are invented that the Go code
 * does not also invent, and the same "drop unusable SNI/host" guard
 * (validURLHost) is applied so configs that would crash Xray's XHTTP
 * transport are filtered out identically.
 */

// ─── base64 ────────────────────────────────────────────────────────────────

/**
 * Decode base64 trying all four alphabets after padding to a multiple of 4,
 * mirroring converter.go's b64DecodeSafe (used for vmess/ss bodies).
 * Returns a UTF-8 string, or null on failure.
 *
 * IMPORTANT: Node's Buffer.from(str, "base64") is lenient — it silently
 * discards non-alphabet characters instead of failing, so "aes-256-gcm:pass"
 * (which contains ':' and '-') "decodes" to garbage. Go's base64 decoders
 * reject such input outright. We therefore use atobStrict (which validates
 * the alphabet) as the single source of truth, matching Go semantics.
 */
export function b64DecodeSafe(str) {
  const s = String(str ?? "").trim();
  if (!s) return null;
  const padLen = (4 - (s.length % 4)) % 4;
  const padded = s + "=".repeat(padLen);
  // Try padded (Std/URL encodings) then unpadded (RawStd/RawURL), matching
  // the four Go encodings in converter.go order.
  for (const input of [padded, s]) {
    const decoded = atobStrict(input);
    if (decoded !== null) return decoded;
  }
  return null;
}

/**
 * Strict base64 decode via atob with alphabet validation. Returns UTF-8 string
 * or null. atob throws on invalid chars, which gives us the correctness gate
 * that Buffer.from lacks.
 */
function atobStrict(input) {
  // Normalize URL-safe → standard.
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  // Must only contain base64 alphabet chars (after padding normalization).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  try {
    const binary = atob(normalized);
    // Convert binary string → UTF-8.
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Decode a whole subscription blob the way v2go's main.go does
 * (StdEncoding only, with padding). Returns the decoded string or null.
 * Used for subscription bodies that are entirely base64-encoded.
 */
export function decodeSubscriptionBase64(encoded) {
  const str = String(encoded ?? "");
  if (!str) return null;
  const padLen = (4 - (str.length % 4)) % 4;
  const padded = str + "=".repeat(padLen);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Reports whether h can be used as the host of a URL. Matches converter.go's
 * validURLHost: parse "https://"+h+"/" and confirm the host round-trips.
 * Bracketed IPv6 literals like [2001:db8::1] remain valid.
 */
export function validURLHost(h) {
  if (!h) return false;
  try {
    const u = new URL("https://" + h + "/");
    return u.host === h;
  } catch {
    return false;
  }
}

function parsePort(s) {
  if (s === "" || s == null) throw new Error("missing port");
  const p = Number(s);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`invalid port: ${s}`);
  }
  return p;
}

/** Split "host:port" or "[ipv6]:port". Returns [host, port]. */
function splitHostPort(s) {
  const str = String(s ?? "").trim();
  if (str.startsWith("[")) {
    const end = str.indexOf("]");
    if (end < 0 || end + 1 >= str.length || str[end + 1] !== ":") {
      throw new Error(`invalid IPv6: ${str}`);
    }
    const host = str.slice(1, end);
    const port = parsePort(str.slice(end + 2));
    return [host, port];
  }
  const i = str.lastIndexOf(":");
  if (i < 0) throw new Error("missing port");
  const port = parsePort(str.slice(i + 1));
  return [str.slice(0, i), port];
}

/** first non-empty value among the named URLSearchParams keys. */
function first(params, ...keys) {
  for (const k of keys) {
    const v = params.get(k);
    if (v) return v;
  }
  return "";
}

function firstOr(params, def, ...keys) {
  const v = first(params, ...keys);
  return v || def;
}

// ─── protocol detection ───────────────────────────────────────────────────

const PROTOCOL_PREFIXES = [
  ["vless://", "vless"],
  ["vmess://", "vmess"],
  ["ss://", "ss"],
  ["trojan://", "trojan"],
  ["hysteria2://", "hysteria2"],
  ["hy2://", "hysteria2"],
];

export function getProtocol(link) {
  const l = String(link ?? "").trim();
  for (const [prefix, name] of PROTOCOL_PREFIXES) {
    if (l.startsWith(prefix)) return name;
  }
  return "unknown";
}

// ─── stream settings builder (central) ────────────────────────────────────

/**
 * Build streamSettings from a URLSearchParams-like map. This is the heart of
 * the converter and is shared by vless/vmess/trojan. Ported line-for-line
 * from converter.go buildStreamSettings.
 *
 * @param {URLSearchParams} params
 * @returns {object} streamSettings object
 */
function buildStreamSettings(params) {
  let network = params.get("type") || "tcp";
  // Some link generators emit security=false/0/off/no to mean "no TLS" —
  // passed through raw, Xray rejects the whole config at load time
  // (infra/conf: Unknown security "false"). Normalize the falsy family to
  // the real "none" keyword.
  const rawSecurity = (params.get("security") || "").trim();
  const security = ["", "false", "0", "off", "no", "False", "FALSE"].includes(rawSecurity)
    ? "none"
    : rawSecurity || "none";

  const stream = { network, security };

  if (security === "tls") {
    const tls = {};
    const sni = params.get("sni");
    if (sni && validURLHost(sni)) tls.serverName = sni;
    const fp = params.get("fp");
    if (fp) tls.fingerprint = fp;
    const alpn = params.get("alpn");
    if (alpn) tls.alpn = alpn.split(",");
    const pcs = params.get("pcs");
    if (pcs) tls.pinnedPeerCertSha256 = pcs;
    const vcn = params.get("vcn");
    if (vcn) tls.verifyPeerCertByName = vcn;
    if (Object.keys(tls).length > 0) stream.tlsSettings = tls;
  } else if (security === "reality") {
    const r = {};
    const sni = params.get("sni");
    if (sni && validURLHost(sni)) r.serverName = sni;
    const fp = params.get("fp");
    if (fp) r.fingerprint = fp;
    const pbk = params.get("pbk");
    if (pbk) r.publicKey = pbk;
    const sid = params.get("sid");
    if (sid) r.shortId = sid;
    const spx = params.get("spx");
    if (spx) {
      try {
        r.spiderX = decodeURIComponent(spx);
      } catch {
        r.spiderX = spx;
      }
    }
    if (Object.keys(r).length > 0) stream.realitySettings = r;
  }

  switch (network) {
    case "ws":
    case "websocket": {
      const ws = {};
      const path = params.get("path");
      if (path) {
        try {
          ws.path = decodeURIComponent(path);
        } catch {
          ws.path = path;
        }
      }
      const host = params.get("host");
      if (host) ws.host = host;
      if (Object.keys(ws).length > 0) stream.wsSettings = ws;
      break;
    }
    case "grpc": {
      const g = {};
      const serviceName = params.get("serviceName");
      if (serviceName) g.serviceName = serviceName;
      const authority = params.get("authority");
      if (authority) g.authority = authority;
      if (params.get("mode") === "multi") g.multiMode = true;
      if (Object.keys(g).length > 0) stream.grpcSettings = g;
      break;
    }
    case "httpupgrade": {
      const h = {};
      const path = params.get("path");
      if (path) {
        try {
          h.path = decodeURIComponent(path);
        } catch {
          h.path = path;
        }
      }
      const host = params.get("host");
      if (host) h.host = host;
      if (Object.keys(h).length > 0) stream.httpupgradeSettings = h;
      break;
    }
    case "xhttp":
    case "splithttp": {
      const x = {};
      const path = params.get("path");
      if (path) {
        try {
          x.path = decodeURIComponent(path);
        } catch {
          x.path = path;
        }
      }
      // Xray builds the XHTTP request URL from this host and ignores the
      // error from http.NewRequest, so a host that URL rejects crashes the
      // whole process. Drop it; xray falls back to SNI/destination address.
      const host = params.get("host");
      if (host && validURLHost(host)) x.host = host;
      const mode = params.get("mode");
      if (mode) x.mode = mode;
      if (Object.keys(x).length > 0) stream.xhttpSettings = x;
      break;
    }
    case "tcp":
    case "raw": {
      if (params.get("headerType") === "http") {
        // Match Go's strings.Split(params.Get("host"), ","): Go's url.Values.Get
        // returns "" for a missing key (not null like JS URLSearchParams), and
        // strings.Split("", ",") returns [""]. Coalesce null → "" here.
        const hostVal = params.get("host") ?? "";
        stream.tcpSettings = {
          header: {
            type: "http",
            request: {
              headers: { Host: hostVal.split(",") },
            },
          },
        };
      }
      break;
    }
    default:
      // unknown network — leave stream with just network/security
      break;
  }

  return stream;
}

// ─── per-protocol parsers ─────────────────────────────────────────────────

function parseVLESS(link) {
  const u = new URL(link);
  const params = u.searchParams;
  const port = parsePort(u.port);
  // u.username holds the uuid (no password expected for vless).
  const uuid = decodeURIComponent(u.username);
  if (!uuid) throw new Error("missing UUID");

  const user = { id: uuid, encryption: firstOr(params, "none", "encryption") };
  const flow = first(params, "flow");
  if (flow) user.flow = flow;

  return {
    protocol: "vless",
    tag: "proxy",
    settings: {
      vnext: [
        {
          address: u.hostname,
          port,
          users: [user],
        },
      ],
    },
    streamSettings: buildStreamSettings(params),
  };
}

function parseVMess(link) {
  const raw = link.slice("vmess://".length);
  const decoded = b64DecodeSafe(raw);
  if (decoded === null) throw new Error("base64 decode failed");

  let d;
  try {
    d = JSON.parse(decoded);
  } catch {
    throw new Error("json decode failed");
  }

  let port;
  const portVal = d.port;
  if (typeof portVal === "number") {
    port = portVal;
  } else if (typeof portVal === "string") {
    port = Number(portVal);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`invalid port: ${portVal}`);
    }
  } else {
    throw new Error("missing/invalid port");
  }
  if (port < 1 || port > 65535) throw new Error("port out of range");

  const id = String(d.id ?? "");
  const addr = String(d.add ?? "");
  if (!id || !addr) throw new Error("missing id or add");

  let scy = String(d.scy ?? "");
  if (!scy) scy = String(d.security ?? "");
  if (!scy) scy = "auto";

  let net = String(d.net ?? "");
  if (!net) net = "tcp";
  let tls = String(d.tls ?? "");
  if (!tls) tls = "none";

  const params = new URLSearchParams();
  params.set("type", net);
  params.set("security", tls);
  if (d.sni) params.set("sni", String(d.sni));
  if (d.fp) params.set("fp", String(d.fp));
  if (d.alpn) params.set("alpn", String(d.alpn));

  switch (net) {
    case "ws":
    case "websocket":
    case "httpupgrade":
      if (d.host) params.set("host", String(d.host));
      if (d.path) params.set("path", String(d.path));
      break;
    case "grpc":
      if (d.path) params.set("serviceName", String(d.path));
      if (d.host) params.set("authority", String(d.host));
      if (d.type === "multi") params.set("mode", "multi");
      break;
    case "xhttp":
    case "splithttp":
      if (d.host) params.set("host", String(d.host));
      if (d.path) params.set("path", String(d.path));
      if (d.mode) params.set("mode", String(d.mode));
      break;
    case "tcp":
    case "raw":
      if (d.type && d.type !== "none") params.set("headerType", String(d.type));
      if (d.host) params.set("host", String(d.host));
      break;
    default:
      break;
  }

  return {
    protocol: "vmess",
    tag: "proxy",
    settings: {
      vnext: [
        {
          address: addr,
          port,
          users: [{ id, security: scy }],
        },
      ],
    },
    streamSettings: buildStreamSettings(params),
  };
}

function parseSS(link) {
  let raw = link.slice("ss://".length);

  // Strip fragment (#name) and query (?params) — SS ignores them.
  const hashIdx = raw.lastIndexOf("#");
  if (hashIdx >= 0) raw = raw.slice(0, hashIdx);
  const qIdx = raw.indexOf("?");
  if (qIdx >= 0) raw = raw.slice(0, qIdx);

  let method, password, host, port;
  const atIdx = raw.lastIndexOf("@");
  if (atIdx >= 0) {
    const userinfoPart = raw.slice(0, atIdx);
    const serverPart = raw.slice(atIdx + 1);
    let userinfo;
    const decoded = b64DecodeSafe(userinfoPart);
    if (decoded !== null) {
      userinfo = decoded;
    } else {
      try {
        userinfo = decodeURIComponent(userinfoPart);
      } catch {
        throw new Error("invalid userinfo");
      }
    }
    const parts = userinfo.split(":");
    if (parts.length < 2) throw new Error("invalid userinfo: no ':'");
    method = parts[0];
    password = parts.slice(1).join(":");
    [host, port] = splitHostPort(serverPart);
  } else {
    // Legacy: whole thing is base64(method:password@host:port)
    const decoded = b64DecodeSafe(raw);
    if (decoded === null) throw new Error("base64 decode failed");
    const at = decoded.lastIndexOf("@");
    if (at < 0) throw new Error("legacy SS: no '@'");
    const mp = decoded.slice(0, at);
    const serverPart = decoded.slice(at + 1);
    const parts = mp.split(":");
    if (parts.length < 2) throw new Error("legacy SS: no ':'");
    method = parts[0];
    password = parts.slice(1).join(":");
    [host, port] = splitHostPort(serverPart);
  }

  return {
    protocol: "shadowsocks",
    tag: "proxy",
    settings: {
      servers: [{ address: host, port, method, password }],
    },
    streamSettings: { network: "tcp", security: "none" },
  };
}

function parseTrojan(link) {
  const u = new URL(link);
  const params = u.searchParams;
  const port = parsePort(u.port);
  let password;
  try {
    password = decodeURIComponent(u.username);
  } catch {
    password = u.username;
  }
  if (!password) throw new Error("missing password");
  if (!params.get("security")) params.set("security", "tls");

  return {
    protocol: "trojan",
    tag: "proxy",
    settings: {
      servers: [{ address: u.hostname, port, password }],
    },
    streamSettings: buildStreamSettings(params),
  };
}

function parseHysteria2(link) {
  const u = new URL(link);
  const params = u.searchParams;
  const port = parsePort(u.port);
  let auth = "";
  if (u.username) {
    try {
      auth = decodeURIComponent(u.username);
    } catch {
      auth = u.username;
    }
  }
  if (!auth) throw new Error("missing auth");

  const tlsSettings = {};
  const sni = first(params, "sni");
  if (sni && validURLHost(sni)) tlsSettings.serverName = sni;
  const fp = first(params, "fp", "fingerprint");
  if (fp) tlsSettings.fingerprint = fp;
  const alpn = first(params, "alpn");
  if (alpn) tlsSettings.alpn = alpn.split(",");
  const pcs = first(params, "pcs");
  if (pcs) tlsSettings.pinnedPeerCertSha256 = pcs;
  const vcn = first(params, "vcn");
  if (vcn) tlsSettings.verifyPeerCertByName = vcn;

  // Xray-core gates the "hysteria" network on version == 2 (the hy2 protocol);
  // without the field the binary rejects the whole config at load time
  // ("infra/conf: Failed to build Hysteria config. > version != 2"), so every
  // spawn-mode probe of the node fails before any byte is tunnelled.
  const hySettings = { auth, version: 2 };
  const obfs = first(params, "obfs");
  const obfsPass = first(params, "obfs-password");
  if (obfs && obfsPass) {
    hySettings.obfs = obfs;
    hySettings.obfsPassword = obfsPass;
  }

  const stream = {
    network: "hysteria",
    security: "tls",
    hysteriaSettings: hySettings,
  };
  if (Object.keys(tlsSettings).length > 0) stream.tlsSettings = tlsSettings;

  // NOTE: like converter.go, hysteria2 emits protocol:"trojan" with
  // network:"hysteria" — an Xray-core compatibility shim.
  return {
    protocol: "trojan",
    tag: "proxy",
    settings: {
      servers: [{ address: u.hostname, port, password: auth }],
    },
    streamSettings: stream,
  };
}

// ─── public API ───────────────────────────────────────────────────────────

const PARSERS = {
  vless: parseVLESS,
  vmess: parseVMess,
  ss: parseSS,
  trojan: parseTrojan,
  hysteria2: parseHysteria2,
};

/**
 * Convert a V2Ray share link into an Xray outbound object.
 * @param {string} link — vless://, vmess://, ss://, trojan://, hysteria2://
 * @returns {object} Xray outbound { protocol, tag, settings, streamSettings }
 * @throws {Error} on unsupported protocol or malformed link
 */
export function convertLink(link) {
  const l = String(link ?? "").trim();
  const proto = getProtocol(l);
  const parser = PARSERS[proto];
  if (!parser) throw new Error("unsupported protocol");
  return parser(l);
}

/**
 * Extract the host and port from a share link WITHOUT a full parse.
 * Used for dedup keys and DB indexing. Returns { protocol, host, port } or
 * null if it cannot be cheaply determined.
 */
export function extractEndpoint(link) {
  const l = String(link ?? "").trim();
  const proto = getProtocol(l);
  if (proto === "unknown") return null;
  if (proto === "vmess") {
    const decoded = b64DecodeSafe(l.slice("vmess://".length));
    if (decoded === null) return null;
    try {
      const d = JSON.parse(decoded);
      return { protocol: proto, host: String(d.add ?? ""), port: Number(d.port) || 0 };
    } catch {
      return null;
    }
  }
  try {
    const u = new URL(l);
    return { protocol: proto, host: u.hostname, port: parsePort(u.port) };
  } catch {
    return null;
  }
}
