import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { startDS2API, getCredentials } from "@/lib/ds2api/process";
import { DEFAULT_DS2API_URL, isLoopbackDS2APIUrl } from "@/lib/ds2api/detect";
import { applyDs2apiUrl } from "@/lib/ds2api/resolve";
import * as admin from "@/lib/ds2api/adminClient";
import { createProviderConnection, getModelAliases, setModelAlias } from "@/models";
import { PROVIDER_MODELS } from "open-sse/config/providerModels.js";

export const dynamic = "force-dynamic";

function parsePortFromUrl(url) {
  try {
    const u = new URL(url);
    const p = parseInt(u.port, 10);
    if (p > 0 && p < 65536) return p;
  } catch { /* ignore */ }
  return null;
}

// Give the freshly started sidecar a moment to accept connections before we hit
// its admin API to register the managed caller key.
function waitForReady(base, attempts = 20, delayMs = 250) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = async () => {
      try {
        const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return resolve(true);
      } catch { /* not up yet */ }
      if (++n >= attempts) return resolve(false);
      setTimeout(tick, delayMs);
    };
    tick();
  });
}

export async function POST() {
  try {
    const settings = await getSettings();
    const url = settings.ds2apiUrl || DEFAULT_DS2API_URL;
    if (!isLoopbackDS2APIUrl(url)) {
      return NextResponse.json({ error: "External DS2API must be started outside 9Router", code: "EXTERNAL_PROXY" }, { status: 400 });
    }
    const port = parsePortFromUrl(url) || 5001;
    applyDs2apiUrl(url);
    const result = await startDS2API({ port });

    // Tier B auto-injection: ensure the sidecar accepts the managed caller key, then
    // expose it as a normal ds2api provider connection so 9router routes with it.
    const injection = { skipped: result.alreadyRunning };
    if (!result.alreadyRunning) {
      const base = String(url).replace(/\/$/, "");
      const creds = getCredentials();
      if (creds?.adminKey && creds?.apiKey && (await waitForReady(base))) {
        try {
          await admin.ensureKey(base, creds.adminKey, creds.apiKey);
          await createProviderConnection({
            provider: "ds2api",
            authType: "apikey",
            name: "DeepSeek Web (managed)",
            apiKey: creds.apiKey,
            isActive: true,
            providerSpecificData: { managed: true },
          });
          // Route bare DeepSeek model names ("deepseek-v4-flash"…) to this sidecar
          // so OpenAI clients work without a "ds2api/" prefix. Only fill aliases that
          // are unset — never overwrite a user's manual alias.
          const existing = await getModelAliases();
          const dsModels = PROVIDER_MODELS.ds2api || [];
          for (const m of dsModels) {
            if (!existing[m.id]) await setModelAlias(m.id, `ds2api/${m.id}`);
          }
          injection.injected = true;
        } catch (e) {
          injection.injected = false;
          injection.error = e.message;
        }
      } else {
        injection.injected = false;
        injection.error = "sidecar not ready in time";
      }
    }

    return NextResponse.json({ success: true, ...result, injection });
  } catch (error) {
    const status = error.code === "NOT_INSTALLED" ? 400 : 500;
    return NextResponse.json({ error: error.message, code: error.code || null }, { status });
  }
}
