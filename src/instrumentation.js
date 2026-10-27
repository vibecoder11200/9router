export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // FIRST, at server start (before any page render — the layout-driven
    // runHeavyStartup only fires when the dashboard is actually opened): a
    // managed xray orphaned by a previous app instance (crash, kill, npm -g
    // upgrade) survives detached holding the SOCKS/HTTP ports while the start
    // path reports "already running", wedging both auto-start and manual
    // start until xray.pid is removed by hand. Pure fs + process-table work —
    // no DB, safe to run this early. Idempotent, so the runHeavyStartup copy
    // is a harmless no-op re-check.
    try {
      const { reapOrphanedManagedXray } = await import("@/lib/xray/process.js");
      const reaped = await reapOrphanedManagedXray();
      if (reaped.killed) console.log(`[InitApp] Reaped orphaned managed xray (pid ${reaped.pid}) from a previous instance`);
    } catch (e) {
      console.warn(`[InitApp] Managed-xray orphan reap failed (non-fatal): ${e?.message || e}`);
    }

    // Resume proxyxoay.org rotation + forwarding servers for active pools.
    const { initProxyXoay } = await import("@/lib/proxy/providers/initProxyXoay.js");
    initProxyXoay();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  }
}
