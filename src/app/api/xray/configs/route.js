import { NextResponse } from "next/server";
import { classifyPersistedFilterError } from "@/lib/xray/modelFilterErrors.js";
import {
  getXrayConfigs,
  getXrayConfigCounts,
  getXrayFacets,
  getConfigSubscriptionNames,
  getSettings,
  getModelFilterResultsByConfigIds,
} from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const filter = {
      protocol: searchParams.get("protocol") || undefined,
      country: searchParams.get("country") || undefined,
      isActive: searchParams.get("active") === "1" ? true : searchParams.get("active") === "0" ? false : undefined,
      healthyOnly: searchParams.get("healthy") === "1",
    };
    const facetFilter = {
      isActive: filter.isActive,
    };
    const includeDeleted = searchParams.get("includeDeleted") === "1";
    const [configs, facets, counts, settings, deleted] = await Promise.all([
      getXrayConfigs(filter),
      getXrayFacets(facetFilter),
      getXrayConfigCounts(),
      getSettings(),
      includeDeleted ? getXrayConfigs({ includeDeleted: true }).then((all) => all.filter((c) => c.deletedAt)) : Promise.resolve([]),
    ]);
    // Source-sub names per config for the table badges (one grouped query).
    const subNames = await getConfigSubscriptionNames();
    for (const c of configs) c.subs = subNames.get(c.id) || [];
    // Attach the most recent cached model-filter result per config (for the
    // per-server "Passed Xh ago / Failed / Untested" badge). Keyed by the
    // currently-configured filter model so the badge reflects what the user
    // is actually filtering against.
    const filterModel = typeof settings.xrayModelFilterModel === "string" ? settings.xrayModelFilterModel.trim() : "";
    if (filterModel && configs.length) {
      const cacheMap = await getModelFilterResultsByConfigIds(configs.map((c) => c.id), filterModel);
      for (const c of configs) {
        const r = cacheMap.get(c.id);
        c.modelFilterResult = r
          ? {
              ok: r.ok,
              latencyMs: r.latencyMs,
              testedAt: r.testedAt,
              // Persisted-domain class for the servers-table badge (v0.6.91
              // phase 4). Additive on the already-fetched row — zero extra
              // queries; raw error text stays OUT of the payload.
              errorClass: r.ok ? "usable" : classifyPersistedFilterError({ ok: r.ok, status: r.status, error: r.error }),
            }
          : null;
      }
    } else {
      for (const c of configs) c.modelFilterResult = null;
    }
    return NextResponse.json({ configs, facets, counts, deleted });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
