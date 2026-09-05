// Managed-pool rotation model-agnostic fallback: chat traffic for a model the
// Model Filter never ran with (e.g. oc/mimo-v2.5-free while the filter cache
// only holds rows for the configured filter model, oc/deepseek-v4-flash-free)
// used to abort every rotation with "no-healthy-candidate", pinning the pool
// on the rate-limited IP. The fallback now rotates to any recently-validated
// node; switchConfig live-verifies SOCKS + distinct exit IP.
import { beforeEach, describe, expect, it, vi } from "vitest";

const switchConfigMock = vi.fn(async () => {});
let exactModelRows = [];  // rows for the requested (or prefix-swapped) model
let anyModelRows = [];    // rows across all models (fallback pool)
let selectedConfig = { id: "active-1", name: "Active", lastExitIp: "1.1.1.1" };

vi.mock("../../src/lib/db/repos/xrayRepo.js", () => ({
  getSelectedXrayConfig: vi.fn(async () => selectedConfig),
}));
vi.mock("../../src/lib/db/repos/modelFilterResultsRepo.js", () => ({
  getNextHealthyConfigsForModel: vi.fn(async (_model) => exactModelRows),
  getNextHealthyConfigsAnyModel: vi.fn(async () => anyModelRows),
  getModelFilterResult: vi.fn(async () => null),
  upsertModelFilterResult: vi.fn(async () => {}),
}));
vi.mock("../../src/lib/xray/manager.js", () => ({
  switchConfig: switchConfigMock,
}));

const { triggerManagedRotationOnProxyError, _resetManagedRotationState } = await import(
  "../../src/lib/xray/managedRotation.js"
);

beforeEach(() => {
  _resetManagedRotationState();
  switchConfigMock.mockClear();
  exactModelRows = [];
  anyModelRows = [];
  selectedConfig = { id: "active-1", name: "Active", lastExitIp: "1.1.1.1" };
});

describe("rotation candidate fallback for unfiltered models", () => {
  it("oc/mimo-v2.5-free rotates via cross-model rows when the filter cache only has deepseek", async () => {
    // The user's scenario: filter cache holds rows for the DEAD default filter
    // model only; live traffic runs oc/mimo-v2.5-free and gets a 429.
    exactModelRows = []; // no oc/mimo-v2.5-free rows (nor opencode/… swapped)
    anyModelRows = [
      { configId: "node-b", name: "Node B (deepseek-validated)", latencyMs: 140, exitIp: "2.2.2.2" },
    ];

    const result = await triggerManagedRotationOnProxyError({
      status: 429,
      error: "429 rate limited",
      model: "opencode/mimo-v2.5-free",
    });

    expect(result.rotated).toBe(true);
    expect(result.toConfigId).toBe("node-b");
    expect(switchConfigMock).toHaveBeenCalledTimes(1);
    // Must never re-pick the active config itself.
    expect(switchConfigMock.mock.calls[0][0]).not.toBe("active-1");
  });

  it("exact-model rows still win over the cross-model fallback", async () => {
    exactModelRows = [
      { configId: "mimo-node", name: "Mimo-validated node", latencyMs: 90, exitIp: "5.5.5.5" },
    ];
    anyModelRows = [
      { configId: "node-b", name: "Node B", latencyMs: 50, exitIp: "2.2.2.2" },
    ];

    const result = await triggerManagedRotationOnProxyError({ status: 429, error: "429", model: "oc/mimo-v2.5-free" });

    expect(result.rotated).toBe(true);
    expect(result.toConfigId).toBe("mimo-node");
  });

  it("empty filter cache (nothing ever validated) still aborts cleanly", async () => {
    exactModelRows = [];
    anyModelRows = [];

    const result = await triggerManagedRotationOnProxyError({ status: 429, error: "429", model: "oc/mimo-v2.5-free" });

    expect(result).toEqual({ rotated: false, reason: "no-healthy-candidate" });
    expect(switchConfigMock).not.toHaveBeenCalled();
  });

  it("fallback candidates that share the active exit IP are skipped in favor of distinct ones", async () => {
    exactModelRows = [];
    anyModelRows = [
      { configId: "same-ip", name: "Same IP node", latencyMs: 10, exitIp: "1.1.1.1" },
      { configId: "other-ip", name: "Other IP node", latencyMs: 200, exitIp: "3.3.3.3" },
    ];

    const result = await triggerManagedRotationOnProxyError({ status: 429, error: "429", model: "oc/mimo-v2.5-free" });

    expect(result.rotated).toBe(true);
    expect(result.toConfigId).toBe("other-ip");
  });
});
