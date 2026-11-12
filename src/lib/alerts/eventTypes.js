/**
 * Alert event catalog: stable event-type strings, severity levels, and the
 * Discord embed colors used to tint each severity. Pure data — no imports.
 */

export const EVENT_TYPES = {
  ALL_ACCOUNTS_LOCKED: "all-accounts-locked",
  BREAKER_OPEN: "breaker-open",
  BREAKER_RECOVERED: "breaker-recovered",
  PROXY_POOL_EXHAUSTED: "proxy-pool-exhausted",
  STRICTPROXY_VIOLATION: "strictproxy-violation",
  QUOTA_NEAR_LIMIT: "quota-near-limit",
  BUDGET_THRESHOLD: "budget-threshold",
  XRAY_NODE_DOWN: "xray-node-down",
  XRAY_ROTATION_FAILED: "xray-rotation-failed",
  TOTU_FETCH_FAILED: "totu-fetch-failed",
  // OpenCode v2 free-lane (open-sse/providers/opencodeWire.js + Bun stdio lane)
  OPENCODE_WIRE_DRIFT: "opencode-wire-drift", // snapshot behind upstream CLI — fork release required
  OPENCODE_BUN_LANE_UNAVAILABLE: "opencode-bun-lane-unavailable", // lane transport down (fail-fast, P4)
};

export const SEVERITY = { INFO: "info", WARN: "warn", CRITICAL: "critical" };

// Discord embed colors (integers) per severity.
export const SEVERITY_COLORS = { info: 0x3498db, warn: 0xe67e22, critical: 0xe74c3c };
