// v0.6.91 phase 2 — error-class taxonomy + precedence pin (plan red-team F3).
//
// Prod evidence 261113 (cumulative table rows): 62 × 429 quota · 34 ×
// timeout · 17 × tunnel fail — the dashboard could only say "82 tested /
// 0 usable". classifyFilterError turns each row into a stable class; the
// precedence order is FIRST-MATCH-WINS and pinned here.
import { describe, expect, it } from "vitest";

const {
  classifyFilterError,
  classifyPersistedFilterError,
  bumpErrorBreakdown,
  errorBreakdownEntries,
  FILTER_ERROR_CLASSES,
  FILTER_ERROR_LABELS,
  FILTER_ERROR_VARIANTS,
} = await import("@/lib/xray/modelFilterErrors.js");

describe("classifyFilterError — prod evidence strings (261113)", () => {
  it("classifies the 429 quota wall", () => {
    expect(classifyFilterError({ ok: false, status: 429, error: "[429]: FreeUsageLimitError" })).toBe("quota-429");
    // text-only variant (persisted rows may hold the text without a numeric status)
    expect(classifyFilterError({ ok: false, status: null, error: "rate limited: FreeUsageLimitError" })).toBe("quota-429");
  });

  it("classifies the dead-node timeout", () => {
    expect(classifyFilterError({ ok: false, status: null, error: "Probe timed out after 20000ms" })).toBe("timeout");
    expect(classifyFilterError({ ok: false, status: null, error: "connect ETIMEDOUT 1.2.3.4:443" })).toBe("timeout");
  });

  it("classifies the strict-proxy tunnel failure (incl. the [502] prefix shape)", () => {
    expect(
      classifyFilterError({
        ok: false,
        status: 502,
        error: "[502]: [ProxyFetch] Proxy required but failed (strictProxy=true): [ProxyFetch] Proxy required but failed (strictProxy=true): connect ECONNREFUSED",
      }),
    ).toBe("tunnel");
  });

  it("classifies the default-mode tunnel-check string as tunnel-check, NOT other", () => {
    // freeChatProbe=false dead node (manager.js default-mode return)
    expect(
      classifyFilterError({ ok: false, status: 0, error: "Free-lane model — tunnel connectivity check failed (chat probe skipped)" }),
    ).toBe("tunnel-check");
  });

  it("classifies the v0.6.90 upstream-net string", () => {
    expect(
      classifyFilterError({ ok: false, status: 502, error: "[502]: bun child upstream fetch failed: socket hang up" }),
    ).toBe("upstream-net");
  });

  it("classifies BOTH refusal wordings as tunnel", () => {
    expect(
      classifyFilterError({ ok: false, status: null, error: "[ProxyFetch] strictProxy=true but connection proxy could not be resolved; refusing direct fetch" }),
    ).toBe("tunnel");
    expect(
      classifyFilterError({ ok: false, status: null, error: "[ProxyFetch] Proxy required but none resolved (strictProxy=true)" }),
    ).toBe("tunnel");
  });

  it("buckets the managedRotation edge-ban row as edge-ban, NOT upstream-http", () => {
    // managedRotation.js PK-replaces the verdict with status 403 — the class
    // must not read as a model-gate rejection (red-team R1-F4).
    expect(
      classifyFilterError({ ok: false, status: 403, error: "cloudflare edge ip block (exit ip banned)" }),
    ).toBe("edge-ban");
  });

  it("buckets a healthy-tunnel model-gate rejection as upstream-http (in-memory domain)", () => {
    expect(classifyFilterError({ ok: false, tunnelOk: true, status: 403, error: "model_refused" })).toBe("upstream-http");
    expect(classifyFilterError({ ok: false, tunnelOk: true, status: 500, error: "boom" })).toBe("upstream-http");
    // 429 through a healthy tunnel is quota, not upstream-http (precedence)
    expect(classifyFilterError({ ok: false, tunnelOk: true, status: 429, error: "FreeUsageLimitError" })).toBe("quota-429");
  });

  it("buckets an ok row as usable regardless of other fields", () => {
    expect(classifyFilterError({ ok: true, status: 200, error: null })).toBe("usable");
  });

  it("buckets spawn/infra rows as spawn", () => {
    expect(classifyFilterError({ ok: false, spawnFailed: true, status: null, error: "No active credentials for provider: openai" })).toBe("spawn");
    expect(classifyFilterError({ ok: false, infraError: "wreq-js cannot load", status: null, error: "wreq-js cannot load" })).toBe("spawn");
  });

  it("falls back to other for unknown junk", () => {
    expect(classifyFilterError({ ok: false, status: 503, error: "No active credentials for provider" })).toBe("other");
    expect(classifyFilterError({ ok: false, status: null, error: null })).toBe("other");
    expect(classifyFilterError({})).toBe("other");
  });
});

describe("precedence pins", () => {
  it("ETIMEDOUT cause-text inside a tunnel message buckets as tunnel exactly once", () => {
    // error.js appends "(cause: ETIMEDOUT …)" INSIDE strict-proxy messages —
    // tunnel wordings must win over timeout (red-team R1-F3).
    const cls = classifyFilterError({
      ok: false,
      status: 502,
      error: "[ProxyFetch] Proxy required but failed (strictProxy=true): connect ETIMEDOUT 1.2.3.4:443 (cause: ETIMEDOUT)",
    });
    expect(cls).toBe("tunnel");
  });

  it("429 status beats tunnel wording when both appear", () => {
    expect(
      classifyFilterError({ ok: false, status: 429, error: "[ProxyFetch] Proxy required but failed (strictProxy=true): FreeUsageLimitError" }),
    ).toBe("quota-429");
  });

  it("edge-ban beats upstream-http for 403 rows", () => {
    expect(
      classifyFilterError({ ok: false, tunnelOk: true, status: 403, error: "cloudflare edge ip block" }),
    ).toBe("edge-ban");
  });

  it("precedence array order is exactly the documented first-match order", () => {
    expect([...FILTER_ERROR_CLASSES]).toEqual([
      "usable", "quota-429", "edge-ban", "tunnel", "upstream-net",
      "tunnel-check", "upstream-http", "timeout", "spawn", "other",
    ]);
  });
});

describe("persisted domain (no tunnelOk column)", () => {
  it("upstream-http degrades to the residual non-429 HTTP bucket", () => {
    expect(classifyPersistedFilterError({ ok: false, status: 403, error: "model gate html" })).toBe("upstream-http");
    expect(classifyPersistedFilterError({ ok: false, status: 500, error: "nginx error page" })).toBe("upstream-http");
    // non-HTTP residual rows degrade to other
    expect(classifyPersistedFilterError({ ok: false, status: 0, error: "socket hung up" })).toBe("other");
  });

  it("text fragments keep their classes in the persisted domain", () => {
    expect(classifyPersistedFilterError({ ok: false, status: 429, error: "[429]: FreeUsageLimitError" })).toBe("quota-429");
    expect(classifyPersistedFilterError({ ok: false, status: 502, error: "[502]: bun child upstream fetch failed: x" })).toBe("upstream-net");
    expect(classifyPersistedFilterError({ ok: false, status: 0, error: "Free-lane model — tunnel connectivity check failed (chat probe skipped)" })).toBe("tunnel-check");
    expect(classifyPersistedFilterError({ ok: false, status: null, error: "Probe timed out after 20000ms" })).toBe("timeout");
    expect(classifyPersistedFilterError({ ok: false, status: 403, error: "cloudflare edge ip block" })).toBe("edge-ban");
  });
});

describe("breakdown helpers", () => {
  it("bumpErrorBreakdown accumulates per class", () => {
    const b = {};
    bumpErrorBreakdown(b, { ok: false, status: 429, error: "FreeUsageLimitError" });
    bumpErrorBreakdown(b, { ok: false, status: 429, error: "FreeUsageLimitError" });
    bumpErrorBreakdown(b, { ok: false, status: null, error: "Probe timed out after 20000ms" });
    bumpErrorBreakdown(b, { ok: true });
    expect(b).toEqual({ "quota-429": 2, timeout: 1, usable: 1 });
  });

  it("errorBreakdownEntries: non-zero only, precedence order, other last", () => {
    const entries = errorBreakdownEntries({ other: 3, usable: 2, timeout: 5, "quota-429": 62 });
    expect(entries.map((e) => e.cls)).toEqual(["usable", "quota-429", "timeout", "other"]);
    expect(entries[0]).toMatchObject({ label: "usable", variant: "success" });
    expect(entries[1]).toMatchObject({ label: "429 quota", variant: "warning" });
    // zero classes hidden
    expect(errorBreakdownEntries({ usable: 0, timeout: 1 })).toEqual([
      expect.objectContaining({ cls: "timeout" }),
    ]);
    expect(errorBreakdownEntries(null)).toEqual([]);
    expect(errorBreakdownEntries({})).toEqual([]);
  });

  it("every class has a label and a badge variant", () => {
    for (const cls of FILTER_ERROR_CLASSES) {
      expect(FILTER_ERROR_LABELS[cls]).toBeTruthy();
      expect(["success", "warning", "error"]).toContain(FILTER_ERROR_VARIANTS[cls]);
    }
  });
});
