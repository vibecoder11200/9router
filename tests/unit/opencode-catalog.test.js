import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  ensureOpencodeCatalog,
  isResponsesServed,
  isDeprecatedModel,
  getOpencodeCatalogSnapshot,
  getOpencodeCliUserAgent,
  OPENCODE_UA_FALLBACK,
  __resetOpencodeCatalogForTests,
  __refreshOpencodeCatalogForTests,
} from "../../open-sse/providers/opencodeCatalog.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";

const API_JSON = {
  opencode: {
    id: "opencode",
    models: {
      "muse-spark-2.0-free": { id: "muse-spark-2.0-free", provider: { npm: "@ai-sdk/openai" } },
      "mimo-v3-free": { id: "mimo-v3-free" },
      "deepseek-v5-flash-free": { id: "deepseek-v5-flash-free", status: "deprecated" },
    },
  },
};

function stubFetch(payload, ok = true) {
  return vi.fn(() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 503,
      json: () => Promise.resolve(payload),
    }),
  );
}

describe("opencode api.json catalog", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    __resetOpencodeCatalogForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetOpencodeCatalogForTests();
  });

  it("classifies responses-only and deprecated models from api.json", async () => {
    globalThis.fetch = stubFetch(API_JSON);
    await ensureOpencodeCatalog();

    expect(isResponsesServed("muse-spark-2.0-free")).toBe(true);
    expect(isResponsesServed("mimo-v3-free")).toBe(false);
    expect(isDeprecatedModel("deepseek-v5-flash-free")).toBe(true);
    expect(isDeprecatedModel("mimo-v3-free")).toBe(false);
  });

  it("fails open (registry-only) until the first sync and on fetch errors", async () => {
    // Catalog never loaded: every lookup falls through.
    expect(isResponsesServed("muse-spark-2.0-free")).toBe(false);
    expect(isDeprecatedModel("deepseek-v5-flash-free")).toBe(false);

    // Fetch failure keeps the previous (empty) state and never rejects.
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("network down")));
    await ensureOpencodeCatalog();
    expect(isResponsesServed("muse-spark-2.0-free")).toBe(false);
  });

  it("rejects malformed api.json without touching cached state", async () => {
    globalThis.fetch = stubFetch(API_JSON);
    await ensureOpencodeCatalog();
    expect(isResponsesServed("muse-spark-2.0-free")).toBe(true);

    globalThis.fetch = stubFetch({ unexpected: true });
    await __refreshOpencodeCatalogForTests();
    expect(isResponsesServed("muse-spark-2.0-free")).toBe(true); // last good cache kept
  });

  it("snapshot reports synced state and sorted id lists", async () => {
    expect(getOpencodeCatalogSnapshot()).toEqual({ synced: false, deprecatedIds: [], responsesIds: [] });

    globalThis.fetch = stubFetch(API_JSON);
    await ensureOpencodeCatalog();

    expect(getOpencodeCatalogSnapshot()).toEqual({
      synced: true,
      deprecatedIds: ["deepseek-v5-flash-free"],
      responsesIds: ["muse-spark-2.0-free"],
    });
  });

  it("routes undeclared responses-only models to /zen/v1/responses", async () => {
    globalThis.fetch = stubFetch(API_JSON);
    await ensureOpencodeCatalog();

    const executor = new OpenCodeExecutor();
    expect(executor.buildUrl("muse-spark-2.0-free")).toBe("https://opencode.ai/zen/v1/responses");
    expect(executor.buildUrl("muse-spark-2.0-free(xhigh)")).toBe("https://opencode.ai/zen/v1/responses");
    expect(executor.buildUrl("mimo-v3-free")).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("keeps registry declarations authoritative over the catalog", async () => {
    // Catalog claims nothing; registry-declared muse models still route to /responses.
    globalThis.fetch = stubFetch({ opencode: { models: {} } });
    await ensureOpencodeCatalog();

    const executor = new OpenCodeExecutor();
    expect(executor.buildUrl("muse-spark-1.3-contributor-free")).toBe("https://opencode.ai/zen/v1/responses");
    expect(executor.buildUrl("mimo-v2.5-free")).toBe("https://opencode.ai/zen/v1/chat/completions");
  });

  it("suggested-models filter drops deprecated ids once the catalog is synced", () => {
    const models = [
      { id: "muse-spark-2.0-free" },
      { id: "mimo-v3-free" },
      { id: "deepseek-v5-flash-free" },
      { id: "paid-model" },
    ];
    const suggested = FILTERS["opencode-free"](models).map((m) => m.id);
    // Catalog is empty in this test (not ensured), so nothing is dropped — fail-open.
    expect(suggested).toEqual(["muse-spark-2.0-free", "mimo-v3-free", "deepseek-v5-flash-free"]);
  });

  it("suggested-models filter drops deprecated ids after a sync", async () => {
    globalThis.fetch = stubFetch(API_JSON);
    await ensureOpencodeCatalog();

    const models = [
      { id: "muse-spark-2.0-free" },
      { id: "mimo-v3-free" },
      { id: "deepseek-v5-flash-free" },
      { id: "paid-model" },
    ];
    const suggested = FILTERS["opencode-free"](models).map((m) => m.id);
    expect(suggested).toEqual(["muse-spark-2.0-free", "mimo-v3-free"]);
  });

  it("resolves the zen User-Agent version from npm and falls back when unavailable", async () => {
    // Before any sync: pinned fallback, never a stale hardcoded release.
    expect(getOpencodeCliUserAgent()).toBe(OPENCODE_UA_FALLBACK);

    // Refresh resolves api.json and the npm version in parallel.
    let npmPayload = { version: "9.9.9" };
    globalThis.fetch = vi.fn((url) => {
      const target = String(url);
      if (target.includes("registry.npmjs.org")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(npmPayload) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(API_JSON) });
    });
    await ensureOpencodeCatalog();
    await new Promise((r) => setTimeout(r, 0));
    expect(getOpencodeCliUserAgent()).toBe("opencode/9.9.9 ai-sdk/provider-utils/4.0.38 runtime/bun/1.3.14");

    // A malformed npm payload keeps the last known version.
    npmPayload = { nope: true };
    await __refreshOpencodeCatalogForTests();
    await new Promise((r) => setTimeout(r, 0));
    expect(getOpencodeCliUserAgent()).toBe("opencode/9.9.9 ai-sdk/provider-utils/4.0.38 runtime/bun/1.3.14");
  });
});
