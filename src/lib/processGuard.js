/**
 * Kill-safety helpers: verify a PID actually belongs to one of OUR managed
 * processes before signaling it. A recycled PID that now points at an
 * unrelated user process must never be killed (X7/N4).
 *
 * Zero runtime dependencies (node built-ins only) so the reaper can import it
 * without breaking its dependency-free boot constraint.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Three-state ownership probe. "unknown" means the process IS (or may be)
 * alive but ownership could not be proven — the probing tool failed, timed
 * out, or was blocked. Callers that would double-start or orphan a live
 * process on a false negative must treat "unknown" conservatively; callers
 * deciding whether to KILL must treat it as not-ours (never act on a PID we
 * cannot prove is ours).
 *
 * @param {number} pid
 * @param {string} expectSubstring - substring of the expected command line
 * @returns {"ours"|"gone"|"unknown"}
 */
export function probeProcess(pid, expectSubstring) {
  const target = Number(pid);
  if (!Number.isFinite(target) || target <= 0 || target === process.pid) return "gone";

  // Existence check first (works on every platform): distinguishes "the
  // process is gone" — a definitive, safe answer — from "the ownership probe
  // failed", which is NOT evidence the process is dead (X7: a slow or
  // blocked PowerShell-CIM query used to make a live managed xray look
  // stopped, get its PID file deleted, and brick restarts).
  try {
    process.kill(target, 0);
  } catch (e) {
    if (e?.code === "ESRCH") return "gone"; // no such process
    if (e?.code === "EPERM") {
      // Alive but owned by another user — could still be ours under sudo.
      // Fall through to the cmdline probe.
    } else {
      return "unknown";
    }
  }

  let cmdline = "";
  try {
    if (process.platform === "win32") {
      // /proc is unavailable on Windows; query CIM. wmic is deprecated on
      // modern Windows, so go straight to PowerShell.
      cmdline = execFileSync(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${target}").CommandLine`,
        ],
        { windowsHide: true, timeout: 5000, encoding: "utf8" }
      ) || "";
    } else {
      // Fast path: /proc (Linux; sometimes present under Git Bash on macOS no).
      try {
        cmdline = fs.readFileSync(`/proc/${target}/cmdline`, "utf8");
      } catch {
        cmdline = execFileSync(
          "ps", ["-p", String(target), "-o", "command="],
          { timeout: 5000, encoding: "utf8" }
        ) || "";
      }
    }
  } catch {
    // Alive (kill(0) succeeded) but the cmdline probe failed — unproven.
    return "unknown";
  }

  // Empty cmdline on an ALIVE process (Windows CIM returns $null with exit 0
  // when the querying context cannot read the process — e.g. a non-elevated
  // dashboard querying a sudo/elevated xray) is UNPROVABLE, not evidence of
  // PID reuse. Only a non-empty, non-matching cmdline proves "gone".
  const trimmed = cmdline.trim();
  if (!trimmed) return "unknown";
  const matches = typeof expectSubstring === "string"
    ? trimmed.includes(expectSubstring)
    : true;
  return matches ? "ours" : "gone"; // alive, named, and different → not ours
}

/**
 * Does `pid` belong to us — i.e. does its command line contain the expected
 * binary-path substring? Returns false when the process is gone, the probing
 * tool fails, or the cmdline doesn't match (fail-safe: never act on a PID we
 * cannot prove is ours). Use probeProcess() when "probe failed" needs to be
 * distinguished from "process gone".
 *
 * @param {number} pid
 * @param {string} expectSubstring - substring of the expected command line
 *   (e.g. "xray", "ds2api", or the full binary path).
 * @returns {boolean}
 */
export function isOurProcess(pid, expectSubstring) {
  return probeProcess(pid, expectSubstring) === "ours";
}
