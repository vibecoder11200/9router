// v0.6.91 phase 1 — strictProxy annotation is idempotent.
//
// The opencode probe path nests two strict-proxy catch layers inside one
// call: fetchWithTlsFallback's directFetch bridge (`run()`) annotates and
// rethrows, then proxyAwareFetch's own catch catches the SAME error object
// and annotated it AGAIN — the stored error text doubled:
//   [ProxyFetch] Proxy required but failed (strictProxy=true): [ProxyFetch] Proxy required but failed (strictProxy=true): ...
// The `proxyInfra` flag (already set by every annotate site) is the natural
// idempotency marker; every annotate site now guards on it.
import { describe, expect, it, vi } from "vitest";

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

const PREFIX = "[ProxyFetch] Proxy required but failed (strictProxy=true)";
const countPrefix = (msg) => (msg.match(/\[ProxyFetch\] Proxy required but failed/g) || []).length;

const strictBridgeOptions = (underlying) => ({
  directFetch: vi.fn(async () => {
    throw underlying;
  }),
  // bridge opt-in shapes: executors copy proxyBridge into this flag (base.js);
  // direct callers may set `.proxyBridge` on directFetch itself.
  directFetchProxyBridge: true,
});

function assertGuardsSurvive(err) {
  // Annotate, never replace: adapter guards and the cause chain survive.
  expect(err.proxyInfra).toBe(true);
}

describe("strictProxy prefix stays idempotent across nested catch layers", () => {
  it("annotates a nested bridge strict failure exactly once", async () => {
    const err = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      strictBridgeOptions(new Error("connect ECONNREFUSED 127.0.0.1:59999")),
      { enabled: true, url: "http://127.0.0.1:59999", strictProxy: true },
    ).then(
      () => {
        throw new Error("expected proxyAwareFetch to reject");
      },
      (e) => e,
    );

    expect(countPrefix(err.message)).toBe(1);
    expect(err.message).toContain("connect ECONNREFUSED");
    assertGuardsSurvive(err);
  });

  it("refusal-wording errors (pre-flagged) cross outer strict layers unannotated", async () => {
    // The :641/:720 refusal sites throw fresh errors with the flag already
    // set and WITHOUT the "…but failed" prefix. The guard must suppress
    // re-annotation for them too (plan red-team R2-F7 pin).
    const refusal = new Error("[ProxyFetch] strictProxy=true but connection proxy could not be resolved; refusing direct fetch");
    refusal.proxyInfra = true;
    const err = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      strictBridgeOptions(refusal),
      { enabled: true, url: "http://127.0.0.1:59999", strictProxy: true },
    ).then(
      () => {
        throw new Error("expected proxyAwareFetch to reject");
      },
      (e) => e,
    );

    expect(countPrefix(err.message)).toBe(0);
    expect(err.message).toContain("refusing direct fetch");
    expect(err.proxyInfra).toBe(true);
  });

  it("re-annotation stays suppressed through a THIRD nested layer", async () => {
    // Simulate one more outer annotate layer re-catching the propagated
    // error: once the flag is set the message is never touched again.
    const underlying = new Error("socket hang up");
    let caught;
    try {
      await proxyAwareFetch(
        "https://api.example.com/v1/chat",
        strictBridgeOptions(underlying),
        { enabled: true, url: "http://127.0.0.1:59999", strictProxy: true },
      );
    } catch (e) {
      caught = e;
    }
    // Mimic an additional generic strict wrap (e.g. a future caller-level
    // annotate site): the wrap guards on the flag like production code does,
    // and the guard holds — no second prefix.
    if (!caught?.proxyInfra) {
      caught.message = `${PREFIX}: ${caught.message}`;
    }
    expect(countPrefix(caught.message)).toBe(1);
  });

  it("non-strict bridge failures keep their raw message (no annotation)", async () => {
    const err = await proxyAwareFetch(
      "https://api.example.com/v1/chat",
      strictBridgeOptions(new Error("connect ECONNREFUSED 127.0.0.1:59999")),
      { enabled: true, url: "http://127.0.0.1:59999", strictProxy: false },
    ).then(
      () => {
        throw new Error("expected proxyAwareFetch to reject");
      },
      (e) => e,
    );

    expect(countPrefix(err.message)).toBe(0);
    expect(err.proxyInfra).toBeUndefined();
  });
});
