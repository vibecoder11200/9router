import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __test__, resolveXrayHttpProxyUrl } from "../../src/lib/xray/httpProxyResolver.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("stopXrayService status fix (plan P5)", () => {
  it("stopped status clears httpPort (latent bug: it survived a stop)", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/lib/xray/manager.js"), "utf8");
    expect(src).toMatch(/setStatus\("stopped", \{ pid: null, activeConfigId: null, socksPort: null, httpPort: null, lastError: null \}\)/);
  });
});

beforeEach(() => {
  __test__.reset();
});

afterEach(() => {
  __test__.reset();
});

describe("resolveXrayHttpProxyUrl — derivation + TCP-verify", () => {
  it("loopback socks + open verify → derived http URL", async () => {
    __test__.setVerifyFn(async () => true);
    const out = await resolveXrayHttpProxyUrl("socks5://127.0.0.1:10808");
    expect(out).toBe("http://127.0.0.1:10809");
  });

  it("socks5h accepted (loopback)", async () => {
    __test__.setVerifyFn(async () => true);
    expect(await resolveXrayHttpProxyUrl("socks5h://127.0.0.1:51808")).toBe("http://127.0.0.1:51809");
  });

  it("closed verify → null and negatively cached", async () => {
    let calls = 0;
    __test__.setVerifyFn(async () => {
      calls++;
      return false;
    });
    expect(await resolveXrayHttpProxyUrl("socks5://127.0.0.1:10808")).toBeNull();
    expect(await resolveXrayHttpProxyUrl("socks5://127.0.0.1:10808")).toBeNull();
    expect(calls).toBe(1); // negative cache: verify ran once within the TTL
  });

  it("positive results are NOT cached (fresh verify each resolve)", async () => {
    let calls = 0;
    __test__.setVerifyFn(async () => {
      calls++;
      return true;
    });
    await resolveXrayHttpProxyUrl("socks5://127.0.0.1:10808");
    await resolveXrayHttpProxyUrl("socks5://127.0.0.1:10808");
    expect(calls).toBe(2);
  });

  it("rejects non-loopback hosts, http:// input, garbage, and missing ports", async () => {
    __test__.setVerifyFn(async () => true);
    expect(await resolveXrayHttpProxyUrl("socks5://10.0.0.5:10808")).toBeNull();
    expect(await resolveXrayHttpProxyUrl("http://127.0.0.1:10808")).toBeNull();
    expect(await resolveXrayHttpProxyUrl("not a url")).toBeNull();
    expect(await resolveXrayHttpProxyUrl("socks5://127.0.0.1")).toBeNull();
    expect(await resolveXrayHttpProxyUrl("socks5://127.0.0.1:0")).toBeNull();
    expect(await resolveXrayHttpProxyUrl(null)).toBeNull();
    expect(await resolveXrayHttpProxyUrl(undefined)).toBeNull();
  });

  it("verify=false returns the derived URL without probing (callers that already know)", async () => {
    let calls = 0;
    __test__.setVerifyFn(async () => {
      calls++;
      return true;
    });
    expect(await resolveXrayHttpProxyUrl("socks5://127.0.0.1:10808", { verify: false })).toBe("http://127.0.0.1:10809");
    expect(calls).toBe(0);
  });

  it("ground truth: resolves against a REAL loopback listener", async () => {
    const server = net.createServer(() => {});
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    try {
      const out = await resolveXrayHttpProxyUrl(`socks5://127.0.0.1:${port - 1}`);
      expect(out).toBe(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  });
});
