/**
 * v2go/xray health-check scheduler (phase 07) — wires the existing
 * `xrayHealthCheckIntervalMin` setting (default 10) to an interval that runs
 * manager.runHealthCheck: probe failures emit xray-node-down from inside
 * manager.js (phase-05-owned — NOT here); this scheduler only surfaces the
 * rotation outcome as xray-rotation-failed.
 *
 * 0 = manual-only (timer cleared, mirroring the TOTU scheduler semantics).
 * The tick self-guards: runHealthCheck returns { skipped: true } when no
 * managed xray runs, so non-v2go installs pay one cheap dynamic import per
 * interval. State survives Next.js HMR via the global (TOTU pattern).
 */

import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";

const g = (global.__xrayHealthScheduler ??= {
  interval: null,
  intervalMs: 0,
  running: false,
  lastRunAt: null,
  lastResult: null,
});

export async function runXrayHealthCheckTick(state = g) {
  // Single-flight: the flag is set synchronously before any await (P8).
  if (state.running) return { skipped: "in-flight" };
  state.running = true;
  try {
    const { runHealthCheck } = await import("@/lib/xray/manager.js");
    const result = await runHealthCheck();
    state.lastRunAt = new Date().toISOString();
    if (result?.skipped) {
      state.lastResult = "skipped";
      return result;
    }
    if (result?.rotationFailed) {
      state.lastResult = "rotation-failed";
      try {
        emitAlert(EVENT_TYPES.XRAY_ROTATION_FAILED, {
          severity: SEVERITY.CRITICAL,
          dedupKey: "xray-rotation",
          title: "Xray auto-rotation failed",
          body: `Health check found the active node down and ${result.rotationError || "every rotation candidate failed"}.`,
        });
      } catch { /* alerts must never break the tick */ }
      return result;
    }
    state.lastResult = result?.rotatedTo
      ? `rotated:${result.rotatedTo}`
      : (typeof result?.latencyMs === "number" && result.latencyMs > 0 ? "ok" : "down");
    return result;
  } catch (error) {
    state.lastResult = `error:${String(error?.message || error).slice(0, 120)}`;
    console.warn("[XrayHealth] tick error:", error?.message || error);
    return { error: String(error?.message || error) };
  } finally {
    state.running = false;
  }
}

export function stopXrayHealthCheck(state = g) {
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = null;
  }
  state.intervalMs = 0;
}

export function configureXrayHealthCheck(settings = {}, state = g) {
  const n = Number(settings.xrayHealthCheckIntervalMin ?? 10);
  // 0 / negative / NaN = manual-only (N6): never run, not even clamped.
  if (!Number.isFinite(n) || n <= 0) {
    stopXrayHealthCheck(state);
    return;
  }
  if (state.interval) clearInterval(state.interval);
  const ms = Math.max(5, Math.floor(n)) * 60_000;
  if (Math.floor(n) < 5) {
    console.warn(`[XrayHealth] configured interval ${n} min is below the 5-minute minimum — clamped to 5 min`);
  }
  state.intervalMs = ms;
  state.interval = setInterval(() => {
    runXrayHealthCheckTick(state).catch(() => { /* tick never rejects; belt for HMR */ });
  }, ms);
  if (state.interval.unref) state.interval.unref();
  console.log(`[XrayHealth] scheduler armed (every ${ms / 60_000} min)`);
}

export function getXrayHealthSchedulerState(state = g) {
  return {
    armed: !!state.interval,
    running: state.running,
    intervalMs: state.intervalMs,
    lastRunAt: state.lastRunAt,
    lastResult: state.lastResult,
  };
}

/** Test hook: stop the timer and forget run state. */
export function __resetXrayHealthSchedulerForTests() {
  stopXrayHealthCheck();
  g.lastRunAt = null;
  g.lastResult = null;
  g.running = false;
}
