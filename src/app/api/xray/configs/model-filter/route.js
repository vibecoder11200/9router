import { NextResponse } from "next/server";
import { runModelFilterJob, isModelFilterRunning, getModelFilterStatus } from "@/lib/xray/manager";

export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) return NextResponse.json({ error: "model is required" }, { status: 400 });

    const all = body.all === true || body.limit === "all";
    const limit = all ? "all" : Math.max(1, Math.min(Number(body.limit) || 50, 500));
    const concurrency = Math.max(1, Math.min(Number(body.concurrency) || 2, 16));
    const pauseOnTraffic = body.pauseOnTraffic !== false;
    const quietMs = Math.max(3000, Math.min(Number(body.quietMs) || 15000, 120000));
    const timeoutMs = Math.max(5000, Math.min(Number(body.timeoutMs) || 20000, 60000));
    const prune = body.prune === true;
    const forceRetest = body.forceRetest === true;
    // Opt-in: free-lane (noAuth) providers get REAL chat probes instead of
    // connectivity-only checks. Costs one tiny completion per tested config
    // of real free-tier quota — "usable" then means the exit IP answers.
    const freeChatProbe = body.freeChatProbe === true;

    // Fire-and-forget: a run spans minutes (dozens of nodes × probe timeouts
    // + traffic pauses), and holding this HTTP request open for the whole job
    // gets it killed mid-flight by the transport (408s in the wild) while the
    // job keeps running server-side — the browser then reports a failure for
    // a run that is actually still going. Start the job and answer with the
    // current status immediately; the dashboard already polls
    // /api/xray/status for progress and completion.
    if (isModelFilterRunning()) {
      return NextResponse.json({ success: true, skipped: true, reason: "already_running", ...getModelFilterStatus() });
    }
    runModelFilterJob({ model, limit, all, prune, timeoutMs, concurrency, pauseOnTraffic, quietMs, source: "manual", forceRetest, freeChatProbe })
      .catch(() => { /* the job records its own error into getModelFilterStatus() */ });
    return NextResponse.json({ success: true, started: true, ...getModelFilterStatus() });
  } catch (error) {
    const status =
      ["BAD_REQUEST", "BAD_MODEL", "NO_CREDENTIALS", "NOT_INSTALLED"].includes(error.code)
        ? 400
        : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
