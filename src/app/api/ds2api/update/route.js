import { NextResponse } from "next/server";
import { installDS2API } from "@/lib/ds2api/install";
import { stopDS2API, getManagedPid, isPidAlive } from "@/lib/ds2api/process";
import { startManagedDS2API } from "@/lib/ds2api/lifecycle";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Wait for a pid to disappear from the process table. stopDS2API() returns
// immediately after SIGTERM (SIGKILL is scheduled 2s later), but on Windows a
// running binary is locked and can't be overwritten, so we must block here until
// the process is truly gone before the installer touches the file.
function waitForExit(pid, attempts = 40, delayMs = 250) {
  return new Promise((resolve) => {
    if (!pid || !isPidAlive(pid)) return resolve(true);
    let n = 0;
    const tick = () => {
      if (!isPidAlive(pid)) return resolve(true);
      if (++n >= attempts) return resolve(false);
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

// Update the ds2api engine to DS2API_VERSION. Forces a re-download even when a
// binary is present. On Windows (and any OS) a running engine holds a lock on
// the binary, so this orchestrates stop → wait → install → restart when the
// engine was running, or just installs when it was stopped. Always returns the
// fresh install status plus a flag indicating whether the engine was restarted.
export async function POST() {
  try {
    const wasRunning = !!getManagedPid();
    let stopped = false;
    if (wasRunning) {
      const pid = getManagedPid();
      const r = stopDS2API();
      stopped = !!r.stopped;
      await waitForExit(pid);
    }

    const install = await installDS2API({ force: true });

    // Only restart when the engine was running before the update — don't spin up
    // a sidecar the user had deliberately stopped.
    let restarted = false;
    let startError = null;
    if (wasRunning) {
      try {
        await startManagedDS2API();
        restarted = true;
      } catch (e) {
        startError = e.message;
      }
    }

    return NextResponse.json({ ...install, updated: true, wasRunning, stopped, restarted, startError });
  } catch (error) {
    const status = error.code === "UNSUPPORTED_PLATFORM" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
