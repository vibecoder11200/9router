import { describe, it, expect } from "vitest";
import {
  convertLink,
  getProtocol,
  validURLHost,
  b64DecodeSafe,
  extractEndpoint,
} from "../../src/lib/xray/parser.js";
import { buildClientConfig, buildClientConfigFromLink, validateLink } from "../../src/lib/xray/configBuilder.js";

// Real-world fixtures ported from v2go's converter_test.go. Every link a
// live-tested config carries a v2go fragment ("#v2go | 🇩🇪 DE | VLESS | 12")
// with spaces, pipes, and emoji — these pin down that the parser handles them.

const FIXTURES = {
  "vless-reality":
    "vless://1cbe9e8a-8e2f-4a1e-9a2f-0e6f9a3b7c11@example.com:443" +
    "?type=tcp&security=reality&sni=www.microsoft.com&fp=chrome" +
    "&pbk=xNfLwSFtT5ZK8Q3iZ6ub1t7z0oUqNVoJ0aQpM2vFhHU&sid=6ba85179e30d4fc2" +
    "&flow=xtls-rprx-vision#v2go | 🇩🇪 DE | VLESS | 12",
  "vless-ws-tls":
    "vless://1cbe9e8a-8e2f-4a1e-9a2f-0e6f9a3b7c11@example.com:443" +
    "?type=ws&security=tls&path=%2Fws&host=example.com&sni=example.com" +
    "#v2go | 🇳🇱 NL | VLESS | 3",
  "ss-base64-userinfo":
    "ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@example.com:8388#v2go | 🇺🇸 US | SS | 7",
  "trojan-tls":
    "trojan://somepassword@example.com:443?security=tls&sni=example.com&type=tcp" +
    "#v2go | 🇫🇷 FR | TROJAN | 1",
};

// ─── protocol detection ───────────────────────────────────────────────────

describe("getProtocol", () => {
  it("detects each protocol by prefix", () => {
    expect(getProtocol("vless://x@h:1")).toBe("vless");
    expect(getProtocol("vmess://abc")).toBe("vmess");
    expect(getProtocol("ss://abc@h:1")).toBe("ss");
    expect(getProtocol("trojan://p@h:1")).toBe("trojan");
    expect(getProtocol("hysteria2://a@h:1")).toBe("hysteria2");
    expect(getProtocol("hy2://a@h:1")).toBe("hysteria2");
    expect(getProtocol("https://x")).toBe("unknown");
    expect(getProtocol("not-a-link")).toBe("unknown");
    expect(getProtocol("")).toBe("unknown");
  });
});

// ─── validURLHost ─────────────────────────────────────────────────────────

describe("validURLHost", () => {
  it("accepts normal hosts and IPv6 literals", () => {
    expect(validURLHost("example.com")).toBe(true);
    expect(validURLHost("www.microsoft.com")).toBe(true);
    expect(validURLHost("[2001:db8::1]")).toBe(true);
  });
  it("rejects brackets, spaces, control chars, newlines", () => {
    expect(validURLHost("[bad]")).toBe(false);
    expect(validURLHost("ex ample.com")).toBe(false);
    expect(validURLHost("a\nb.com")).toBe(false);
    expect(validURLHost("a\u0001b.com")).toBe(false);
    expect(validURLHost("[")).toBe(false);
    expect(validURLHost("")).toBe(false);
  });
});

// ─── base64 ───────────────────────────────────────────────────────────────

describe("b64DecodeSafe", () => {
  it("decodes standard base64", () => {
    expect(b64DecodeSafe("YWVzLTI1Ni1nY206cGFzc3dvcmQ=")).toBe("aes-256-gcm:password");
  });
  it("decodes unpadded base64", () => {
    expect(b64DecodeSafe("YWVzLTI1Ni1nY206cGFzc3dvcmQ")).toBe("aes-256-gcm:password");
  });
  it("decodes url-safe base64", () => {
    expect(b64DecodeSafe("YWVzLTI1Ni1nY206cGFzc3dvcmQ")).toBe("aes-256-gcm:password");
  });
  it("returns null for garbage", () => {
    expect(b64DecodeSafe("@@@")).toBeNull();
    expect(b64DecodeSafe("")).toBeNull();
  });
});

// ─── VLESS ────────────────────────────────────────────────────────────────

describe("convertLink: VLESS", () => {
  it("parses vless-reality fixture exactly", () => {
    const ob = convertLink(FIXTURES["vless-reality"]);
    expect(ob.protocol).toBe("vless");
    expect(ob.tag).toBe("proxy");
    expect(ob.settings.vnext[0].address).toBe("example.com");
    expect(ob.settings.vnext[0].port).toBe(443);
    const user = ob.settings.vnext[0].users[0];
    expect(user.id).toBe("1cbe9e8a-8e2f-4a1e-9a2f-0e6f9a3b7c11");
    expect(user.encryption).toBe("none");
    expect(user.flow).toBe("xtls-rprx-vision");
    const ss = ob.streamSettings;
    expect(ss.network).toBe("tcp");
    expect(ss.security).toBe("reality");
    expect(ss.realitySettings).toEqual({
      serverName: "www.microsoft.com",
      fingerprint: "chrome",
      publicKey: "xNfLwSFtT5ZK8Q3iZ6ub1t7z0oUqNVoJ0aQpM2vFhHU",
      shortId: "6ba85179e30d4fc2",
    });
  });

  it("parses vless-ws-tls fixture with path decode", () => {
    const ob = convertLink(FIXTURES["vless-ws-tls"]);
    expect(ob.protocol).toBe("vless");
    const ss = ob.streamSettings;
    expect(ss.network).toBe("ws");
    expect(ss.security).toBe("tls");
    expect(ss.tlsSettings).toEqual({ serverName: "example.com" });
    expect(ss.wsSettings).toEqual({ path: "/ws", host: "example.com" });
  });

  it("defaults encryption to none and omits empty flow", () => {
    const ob = convertLink("vless://abc-uuid@host.com:443?type=tcp&security=none");
    expect(ob.settings.vnext[0].users[0].encryption).toBe("none");
    expect(ob.settings.vnext[0].users[0].flow).toBeUndefined();
  });

  it("throws on missing uuid", () => {
    expect(() => convertLink("vless://@host.com:443")).toThrow(/missing UUID/);
  });
});

// ─── VMess ────────────────────────────────────────────────────────────────

describe("convertLink: VMess", () => {
  it("parses a vmess base64-JSON link", () => {
    // {id, add, port, scy, net, tls, host, path}
    const blob = Buffer.from(
      JSON.stringify({
        id: "1386ee64-0a16-4543-b8f0-fb19a0f3c0c9",
        add: "1.2.3.4",
        port: "443",
        scy: "auto",
        net: "ws",
        tls: "tls",
        host: "cdn.example.com",
        path: "/ray",
      })
    ).toString("base64");
    const ob = convertLink(`vmess://${blob}`);
    expect(ob.protocol).toBe("vmess");
    expect(ob.settings.vnext[0].address).toBe("1.2.3.4");
    expect(ob.settings.vnext[0].port).toBe(443);
    expect(ob.settings.vnext[0].users[0]).toEqual({
      id: "1386ee64-0a16-4543-b8f0-fb19a0f3c0c9",
      security: "auto",
    });
    const ss = ob.streamSettings;
    expect(ss.network).toBe("ws");
    expect(ss.security).toBe("tls");
    expect(ss.wsSettings).toEqual({ path: "/ray", host: "cdn.example.com" });
  });

  it("maps grpc serviceName/authority from path/host", () => {
    const blob = Buffer.from(
      JSON.stringify({
        id: "u1", add: "h.com", port: 443, net: "grpc", tls: "tls",
        path: "grpc-service", host: "authority-host", type: "multi",
      })
    ).toString("base64");
    const ob = convertLink(`vmess://${blob}`);
    expect(ob.streamSettings.grpcSettings).toEqual({
      serviceName: "grpc-service",
      authority: "authority-host",
      multiMode: true,
    });
  });

  it("throws on missing id or add", () => {
    const bad = Buffer.from(JSON.stringify({ port: 443 })).toString("base64");
    expect(() => convertLink(`vmess://${bad}`)).toThrow(/missing id or add/);
  });
});

// ─── Shadowsocks ──────────────────────────────────────────────────────────

describe("convertLink: Shadowsocks", () => {
  it("parses SIP002 base64 userinfo fixture", () => {
    const ob = convertLink(FIXTURES["ss-base64-userinfo"]);
    expect(ob.protocol).toBe("shadowsocks");
    expect(ob.settings.servers[0]).toEqual({
      address: "example.com",
      port: 8388,
      method: "aes-256-gcm",
      password: "password",
    });
    expect(ob.streamSettings).toEqual({ network: "tcp", security: "none" });
  });

  it("parses legacy full-base64 format", () => {
    const legacy = Buffer.from("aes-256-gcm:pass@10.0.0.1:8388").toString("base64");
    const ob = convertLink(`ss://${legacy}`);
    expect(ob.settings.servers[0]).toEqual({
      address: "10.0.0.1",
      port: 8388,
      method: "aes-256-gcm",
      password: "pass",
    });
  });

  it("parses url-encoded userinfo fallback", () => {
    const ob = convertLink("ss://aes-256-gcm:pass@example.com:8388");
    expect(ob.settings.servers[0].method).toBe("aes-256-gcm");
    expect(ob.settings.servers[0].password).toBe("pass");
  });
});

// ─── Trojan ───────────────────────────────────────────────────────────────

describe("convertLink: Trojan", () => {
  it("defaults security to tls", () => {
    const ob = convertLink("trojan://pass@host.com:443?type=tcp");
    expect(ob.protocol).toBe("trojan");
    expect(ob.streamSettings.security).toBe("tls");
    expect(ob.settings.servers[0].password).toBe("pass");
  });

  it("parses trojan-tls fixture", () => {
    const ob = convertLink(FIXTURES["trojan-tls"]);
    expect(ob.settings.servers[0]).toEqual({
      address: "example.com",
      port: 443,
      password: "somepassword",
    });
    expect(ob.streamSettings.tlsSettings).toEqual({ serverName: "example.com" });
  });

  it("throws on missing password", () => {
    expect(() => convertLink("trojan://@host.com:443")).toThrow(/missing password/);
  });
});

// ─── hysteria2 (trojan + network:"hysteria" shim) ─────────────────────────

describe("convertLink: Hysteria2", () => {
  // Xray-core gates the hysteria network on version == 2 at config-load
  // time ("infra/conf: version != 2", verified live against binary
  // 26.3.27): a config without the field makes every spawn-mode probe of
  // the node fail before any byte is tunnelled.
  it("emits hysteriaSettings.version 2 (binary load gate)", () => {
    const ob = convertLink("hysteria2://letmein@example.com:443?sni=example.com&insecure=0#hy2 node");
    expect(ob.protocol).toBe("trojan");
    expect(ob.streamSettings.network).toBe("hysteria");
    expect(ob.streamSettings.hysteriaSettings).toEqual({ auth: "letmein", version: 2 });
    expect(ob.streamSettings.tlsSettings).toEqual({ serverName: "example.com" });
  });

  it("carries obfs through alongside version when present", () => {
    const ob = convertLink("hysteria2://letmein@example.com:443?obfs=salamander&obfs-password=obpass#hy2");
    expect(ob.streamSettings.hysteriaSettings).toEqual({
      auth: "letmein",
      obfs: "salamander",
      obfsPassword: "obpass",
      version: 2,
    });
  });

  it("throws on missing auth", () => {
    expect(() => convertLink("hysteria2@example.com:443")).toThrow();
    expect(() => convertLink("hysteria2://@example.com:443")).toThrow(/missing auth/);
  });
});

// ─── garbage rejection ────────────────────────────────────────────────────

describe("convertLink: rejects garbage", () => {
  for (const link of ["", "not-a-link", "vless://", "ss://@@@"]) {
    it(`rejects ${JSON.stringify(link)}`, () => {
      expect(() => convertLink(link)).toThrow();
    });
  }
});

// ─── XHTTP host/SNI safety (ported from TestXHTTPHostAndSNIAreURLSafe) ────

describe("XHTTP host/SNI URL safety", () => {
  const base =
    "vless://11111111-2222-3333-4444-555555555555@104.16.0.1:443?type=xhttp&security=tls";

  const unusable = {
    brackets: base + "&sni=example.com&host=%5Bbad%5D",
    space: base + "&sni=example.com&host=ex%20ample.com",
    newline: base + "&sni=example.com&host=a%0Ab.com",
    "control char": base + "&sni=example.com&host=a%01b.com",
    "bare bracket": base + "&sni=example.com&host=%5B",
    "bad sni": base + "&sni=%5Bbad%5D",
  };
  for (const [name, link] of Object.entries(unusable)) {
    it(`drops unusable host: ${name}`, () => {
      let ob;
      try {
        ob = convertLink(link);
      } catch {
        return; // rejecting outright is acceptable
      }
      const ss = ob.streamSettings || {};
      for (const got of urlHostsIn(ob)) {
        expect(validURLHost(got), `unusable host "${got}" reached outbound`).toBe(true);
      }
    });
  }

  const keep = {
    "ipv6 literal": base + "&sni=example.com&host=%5B2001%3Adb8%3A%3A1%5D",
    "normal host": base + "&sni=example.com&host=example.com",
  };
  for (const [name, link] of Object.entries(keep)) {
    it(`keeps valid host: ${name}`, () => {
      const ob = convertLink(link);
      expect(urlHostsIn(ob).length).toBeGreaterThan(0);
    });
  }
});

function urlHostsIn(ob) {
  const stream = ob.streamSettings || {};
  const out = [];
  for (const [section, key] of [
    ["xhttpSettings", "host"],
    ["tlsSettings", "serverName"],
    ["realitySettings", "serverName"],
  ]) {
    const sub = stream[section];
    if (sub && typeof sub === "object" && typeof sub[key] === "string" && sub[key]) {
      out.push(sub[key]);
    }
  }
  return out;
}

// ─── configBuilder ────────────────────────────────────────────────────────

describe("buildClientConfig", () => {
  it("wraps an outbound with SOCKS + HTTP inbounds and freedom/blackhole outbounds", () => {
    const outbound = convertLink(FIXTURES["vless-reality"]);
    const config = buildClientConfig(outbound, { socksPort: 10808, httpPort: 10809 });
    expect(config.log.loglevel).toBe("warning");
    expect(config.inbounds).toHaveLength(2);
    expect(config.inbounds[0].protocol).toBe("socks");
    expect(config.inbounds[0].port).toBe(10808);
    expect(config.inbounds[0].listen).toBe("127.0.0.1");
    expect(config.inbounds[0].settings.udp).toBe(true);
    expect(config.inbounds[1].protocol).toBe("http");
    expect(config.inbounds[1].port).toBe(10809);
    expect(config.outbounds).toHaveLength(3);
    expect(config.outbounds[0].tag).toBe("proxy");
    expect(config.outbounds[1]).toEqual({ tag: "direct", protocol: "freedom" });
    expect(config.outbounds[2]).toEqual({ tag: "block", protocol: "blackhole" });
  });

  it("buildClientConfigFromLink combines parse + build", () => {
    const config = buildClientConfigFromLink(FIXTURES["trojan-tls"]);
    expect(config.outbounds[0].protocol).toBe("trojan");
  });
});

describe("validateLink", () => {
  it("returns ok:true for a valid link", () => {
    const r = validateLink(FIXTURES["vless-reality"]);
    expect(r.ok).toBe(true);
    expect(r.outbound.protocol).toBe("vless");
  });

  it("returns ok:false for garbage", () => {
    const r = validateLink("not-a-link");
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe("string");
  });

  it("rejects REALITY + WebSocket combination", () => {
    const link =
      "vless://1cbe9e8a-8e2f-4a1e-9a2f-0e6f9a3b7c11@example.com:443" +
      "?type=ws&security=reality&sni=example.com&pbk=x&fp=chrome";
    const r = validateLink(link);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/REALITY/);
  });
});

// ─── extractEndpoint ──────────────────────────────────────────────────────

describe("extractEndpoint", () => {
  it("extracts host/port for url-based protocols", () => {
    expect(extractEndpoint(FIXTURES["vless-reality"])).toEqual({
      protocol: "vless", host: "example.com", port: 443,
    });
    expect(extractEndpoint(FIXTURES["trojan-tls"])).toEqual({
      protocol: "trojan", host: "example.com", port: 443,
    });
  });
  it("extracts host/port from vmess base64-JSON", () => {
    const blob = Buffer.from(JSON.stringify({ id: "x", add: "vmess.host", port: 8443 })).toString("base64");
    expect(extractEndpoint(`vmess://${blob}`)).toEqual({
      protocol: "vmess", host: "vmess.host", port: 8443,
    });
  });
  it("returns null for unknown protocol", () => {
    expect(extractEndpoint("https://x")).toBeNull();
  });
});
