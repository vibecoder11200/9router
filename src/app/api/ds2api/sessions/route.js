import { NextResponse } from "next/server";
import { resolveDs2api } from "@/lib/ds2api/context";
import * as admin from "@/lib/ds2api/adminClient";

export const dynamic = "force-dynamic";

// Clear remote DeepSeek sessions so ds2api creates fresh ones on next request
// (helps when an existing session got flagged / "user is muted").
// Body { identifier } clears one account; empty body clears all accounts.
export async function DELETE(request) {
  const { base, adminKey, managedPid } = await resolveDs2api();
  if (!managedPid || !adminKey) {
    return NextResponse.json({ error: "DS2API sidecar is not running" }, { status: 503 });
  }
  try {
    const { identifier } = await request.json().catch(() => ({}));
    if (identifier) {
      return NextResponse.json(await admin.clearSessions(base, adminKey, identifier));
    }
    const { items = [] } = await admin.listAccounts(base, adminKey).catch(() => ({}));
    const results = [];
    for (const acc of items) {
      if (!acc.identifier) continue;
      try {
        results.push({ identifier: acc.identifier, ...(await admin.clearSessions(base, adminKey, acc.identifier)) });
      } catch (e) {
        results.push({ identifier: acc.identifier, success: false, message: e.message });
      }
    }
    return NextResponse.json({ success: true, cleared: results.length, results });
  } catch (error) {
    return NextResponse.json({ error: error.message, detail: error.detail }, { status: error.status || 500 });
  }
}
