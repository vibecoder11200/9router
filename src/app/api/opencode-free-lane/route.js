import { NextResponse } from "next/server";
import { getBunLaneStatus } from "open-sse/services/opencodeBunLane.js";
import { isBunInstalled, getInstalledBunVersion } from "@/lib/runtime/bunInstaller.js";
import { getEmbeddedWireSnapshot } from "open-sse/providers/opencodeWire.js";
import { getSettings } from "@/lib/localDb.js";
import { getLaneUnavailableAlertAt } from "open-sse/executors/opencode.js";

export const dynamic = "force-dynamic";

// R8: the three free models shaped for the OpenAI Responses/Messages wires
// stay gate-refused by the v2 free gate (responses/messages shaping is out of
// scope) — served legacy, 429ing on the v2 gate. Made observable here.
const MODELS_KNOWN_REFUSED = [
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
  "union-alpha",
];

// Observability only — GET, no state mutation. Read-only pulls from the
// wire snapshot, the bun installer, the lane semaphore, and settings.
export async function GET() {
  try {
    const [settings, snapshot] = [
      await getSettings().catch(() => null),
      getEmbeddedWireSnapshot(),
    ];
    const lane = getBunLaneStatus();
    lane.modelsKnownRefused = MODELS_KNOWN_REFUSED;
    return NextResponse.json({
      engine: settings?.opencodeFreeLaneEngine || "bun",
      bun: { installed: isBunInstalled(), version: getInstalledBunVersion() },
      lane,
      snapshot: {
        clientVersion: snapshot.clientVersion,
        sourceSha: snapshot.sourceSha,
        capturedAt: snapshot.capturedAt,
      },
      lastUnavailableAlertAt: getLaneUnavailableAlertAt(),
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
