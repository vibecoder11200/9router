import { describe, expect, it } from "vitest";

// The prune policy guards rotation inventory: a config whose probe failed at
// the UPSTREAM level (HTTP response came back through the tunnel — 429 quota,
// 403 fingerprint) must survive pruning, because the tunnel works and the
// upstream condition is transient (shared free-tier quota resets). Only
// connection-level failures (no response at all) prove the config dead.

const { createPruneCanary, shouldPruneFilterResult } = await import("../../src/lib/xray/filterPrunePolicy.js");

const base = { configId: "cfg-1" };

describe("xray model-filter prune policy", () => {
  it("never prunes when pruning is disabled", () => {
    expect(shouldPruneFilterResult({ ok: false, status: 0 }, { prune: false, ...base }).prune).toBe(false);
  });

  it("never prunes successful probes", () => {
    expect(shouldPruneFilterResult({ ok: true, status: 200 }, { prune: true, ...base }).prune).toBe(false);
  });

  it("keeps a config whose failure was upstream-rejected through a working tunnel (429 quota)", () => {
    const decision = shouldPruneFilterResult(
      { ok: false, tunnelOk: true, status: 429, error: "Rate limit exceeded" },
      { prune: true, ...base },
    );
    expect(decision.prune).toBe(false);
    expect(decision.reason).toBe("upstream_rejected");
  });

  it("keeps a config rejected by the provider fingerprint (403) the same way", () => {
    const decision = shouldPruneFilterResult(
      { ok: false, tunnelOk: true, status: 403, error: "FreeTierError" },
      { prune: true, ...base },
    );
    expect(decision.prune).toBe(false);
    expect(decision.reason).toBe("upstream_rejected");
  });

  it("prunes a config that failed at the connection level (no HTTP response)", () => {
    const decision = shouldPruneFilterResult(
      { ok: false, status: 0, error: "connect ETIMEDOUT" },
      { prune: true, ...base },
    );
    expect(decision.prune).toBe(true);
  });

  it("spares the currently-running active config even on a connection-level failure", () => {
    const decision = shouldPruneFilterResult(
      { ok: false, status: 0, error: "socks dial refused" },
      { prune: true, runningActiveConfigId: "cfg-1", ...base },
    );
    expect(decision.prune).toBe(false);
    expect(decision.reason).toBe("active_config_running");
  });

  it("still prunes a different config while another one is the running active", () => {
    const decision = shouldPruneFilterResult(
      { ok: false, status: 0, error: "socks dial refused" },
      { prune: true, runningActiveConfigId: "cfg-other", ...base },
    );
    expect(decision.prune).toBe(true);
  });

  // v0.6.65/v0.6.66 regression shape: wreq-js failing to load made every
  // probe fail identically and the filter pruned configs one infra error at
  // a time (34 deleted on a production box before the run was stopped).
  it("refuses to prune on an app-side infra failure (wreq-js unavailable)", () => {
    const decision = shouldPruneFilterResult(
      { ok: false, infraError: true, status: 502, error: "[502]: [ProxyFetch] wreq-js unavailable (j is not a function)" },
      { prune: true, ...base },
    );
    expect(decision.prune).toBe(false);
    expect(decision.reason).toBe("infra_error");
  });

  // 2026-10-28 incident shape: Xray 26.3.27 rejected the hysteria2 shim
  // config at load time ("version != 2"), so every temp test xray died
  // before opening its SOCKS port and 351 healthy configs were hard-deleted
  // as "connection-level dead". A spawn-side failure is OUR failure to run
  // the test, not a verdict about the node.
  it("refuses to prune when our test instance never spawned (SOCKS port did not open)", () => {
    const decision = shouldPruneFilterResult(
      { ok: false, spawnFailed: true, status: null, error: "SOCKS port did not open for temp model test" },
      { prune: true, ...base },
    );
    expect(decision.prune).toBe(false);
    expect(decision.reason).toBe("spawn_failed");
  });
});

describe("xray model-filter prune canary", () => {
  const dead = { ok: false, status: 0, error: "connect ETIMEDOUT" };
  const quota429 = { ok: false, tunnelOk: true, status: 429, error: "FreeUsageLimitError" };
  const spawnFail = { ok: false, spawnFailed: true, error: "SOCKS port did not open" };
  const alive = { ok: true, status: 200 };

  it("stays quiet while failures interleave with passes (normal cleanup)", () => {
    const canary = createPruneCanary();
    for (let i = 0; i < 30; i++) {
      canary.record(i % 2 === 0 ? dead : alive);
      expect(canary.shouldSuspend()).toBe(false);
    }
  });

  it("trips after a zero-pass streak of prunable failures and latches", () => {
    const canary = createPruneCanary();
    for (let i = 0; i < 9; i++) {
      canary.record(dead);
      expect(canary.shouldSuspend()).toBe(false);
    }
    canary.record(dead); // 10th: tested>=10, passed==0, streak>=10
    expect(canary.shouldSuspend()).toBe(true);
    expect(canary.suspended).toBe(true);
    // Latched: even a later pass must not re-arm pruning mid-run.
    canary.record(alive);
    expect(canary.shouldSuspend()).toBe(true);
  });

  it("does not trip when the failures are upstream-rejected or spawn-side", () => {
    const canary = createPruneCanary();
    for (let i = 0; i < 50; i++) canary.record(i % 2 === 0 ? quota429 : spawnFail);
    expect(canary.shouldSuspend()).toBe(false);
  });

  it("resets the streak on a pass, so a mixed run never trips", () => {
    const canary = createPruneCanary();
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 9; i++) canary.record(dead);
      canary.record(alive); // streak back to 0 before the 10th dead
    }
    expect(canary.shouldSuspend()).toBe(false);
  });
});
