import { NextResponse } from "next/server";
import { getStatus } from "@/lib/xray/manager";
import { getPrevXrayVersion } from "@/lib/xray/installer";
import { listXraySubscriptions } from "@/lib/db/repos/subscriptionRepo";
import { getSelectedXrayConfig } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // RT-15: `sync` is a SUB-AGNOSTIC aggregate — under multi-subscription a
    // per-sub sourceUrl/lastSyncError would misattribute one sub's state to
    // the whole feature. Per-sub truth lives in GET /api/xray/subscriptions.
    const [status, subscriptions] = await Promise.all([
      Promise.resolve(getStatus()),
      listXraySubscriptions().catch(() => []),
    ]);
    const synced = subscriptions.filter((s) => s.lastSyncAt);
    const lastSyncAt = synced.length
      ? synced.map((s) => s.lastSyncAt).sort().at(-1)
      : null;
    const failingSubs = subscriptions.filter((s) => s.lastSyncError).length;
    const sync = { lastSyncAt, totalSubs: subscriptions.length, failingSubs };

    const activeConfig = status.activeConfigId
      ? await getSelectedXrayConfig().catch(() => null)
      : null;
    // The version retained in `.prev` by the last install (RT-5) — powers
    // the dashboard's one-click Rollback button. Null when nothing is retained.
    const rollbackVersion = getPrevXrayVersion();
    return NextResponse.json({ ...status, rollbackVersion, sync, activeConfig });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
