// GET /api/xray/configs/model-filter/results — persistent per-config filter verdicts (v0.6.91 phase 3), the run-log modal's data source (phase 4).
//
// AUTH (verified in src/dashboardGuard.js):
//  - The prefix "/api/xray/configs/" sits in LOCAL_ONLY_PATHS — reachable only
//    from loopback with auth, or with the CLI token; tunnel access is refused
//    even with the tunnel-dashboard opt-in.
//  - Plus deny-by-default for /api/*: not on the public allow-list, so a valid
//    JWT/CLI token (or requireLogin===false + loopback) is required.
//  - Exposure note (plan red-team F6): under requireLogin === false the
//    isAuthenticated short-circuit lets a tunnel-adjacent dashboard viewer
//    reach local-only routes — this route would then expose inventory-wide
//    error text. Mitigation: `exitIp` is OPT-IN via ?includeExitIp=1 and rows
//    omit it by default. Per-route auth is a documented follow-up (out of
//    scope here).
import { NextResponse } from "next/server";
import {
  getSettings,
  listFilterResultsJoined,
  countFilterResultsJoined,
  scanFilterResults,
} from "@/lib/localDb";
import { classifyPersistedFilterError, FILTER_ERROR_CLASSES } from "@/lib/xray/modelFilterErrors.js";

export const dynamic = "force-dynamic";

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);

    // Model follows the settings badge precedent (configs/route.js): explicit
    // ?model= wins, otherwise the configured filter model, else all models.
    let model = (searchParams.get("model") || "").trim();
    if (!model) {
      const settings = await getSettings();
      model = typeof settings.xrayModelFilterModel === "string" ? settings.xrayModelFilterModel.trim() : "";
    }

    const view = searchParams.get("view") === "summary" ? "summary" : "rows";
    const minTestedAt = (searchParams.get("minTestedAt") || "").trim() || null;
    const activeOnly = searchParams.get("active") !== "0";

    if (view === "summary") {
      const scanRows = await scanFilterResults({ model: model || null, minTestedAt, activeOnly });
      const byClass = {};
      for (const cls of FILTER_ERROR_CLASSES) byClass[cls] = 0;
      let lastTestedAt = null;
      for (const row of scanRows) {
        const cls = classifyPersistedFilterError({
          ok: row.ok === 1 || row.ok === true,
          status: row.status,
          error: row.error,
        });
        byClass[cls] += 1;
        if (!lastTestedAt || (row.testedAt && row.testedAt > lastTestedAt)) lastTestedAt = row.testedAt;
      }
      return NextResponse.json({
        byClass,
        total: scanRows.length,
        lastTestedAt,
        scope: { model: model || null, minTestedAt: minTestedAt || null, activeOnly },
      });
    }

    // rows view — "" and "all" mean no class filter; unknown ids also fall back to none.
    const clsParam = (searchParams.get("class") || "").trim();
    const errorClass = FILTER_ERROR_CLASSES.includes(clsParam) ? clsParam : null;
    const okParam = searchParams.get("ok");
    const ok = okParam === "1" ? true : okParam === "0" ? false : null;
    const includeExitIp = searchParams.get("includeExitIp") === "1";
    const search = (searchParams.get("name") || "").trim() || null;
    const page = Math.max(1, Math.floor(Number(searchParams.get("page")) || 1));
    const pageSize = Math.max(1, Math.min(Math.floor(Number(searchParams.get("pageSize")) || DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE));

    const [rows, total] = await Promise.all([
      listFilterResultsJoined({ model: model || null, errorClass, ok, search, minTestedAt, activeOnly, includeExitIp, page, pageSize }),
      countFilterResultsJoined({ model: model || null, errorClass, ok, search, minTestedAt, activeOnly }),
    ]);

    return NextResponse.json({
      rows,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      scope: { model: model || null, minTestedAt: minTestedAt || null, activeOnly, includeExitIp },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
