import { NextResponse } from "next/server";
import { FILTERS } from "./filters.js";
import { ensureOpencodeCatalog } from "open-sse/providers/opencodeCatalog.js";
import { ensureGensparkCatalog, getGensparkSuggestedModels } from "open-sse/providers/gensparkCatalog.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");
  const type = searchParams.get("type");

  if (!url || !type) {
    return NextResponse.json({ error: "Missing url or type" }, { status: 400 });
  }

  // genspark-web: the model list comes from two selector endpoints merged by
  // the catalog (moa_models_config + models_config), not from the single
  // fetcher URL — serve the catalog snapshot directly.
  if (type === "genspark-web") {
    await ensureGensparkCatalog();
    return NextResponse.json({ data: getGensparkSuggestedModels() });
  }

  const filter = FILTERS[type];
  if (!filter) {
    return NextResponse.json({ error: "Unknown filter type" }, { status: 400 });
  }

  // Warm the opencode api.json catalog so deprecated filtering applies on the
  // first request too. The promise never rejects; on failure the filter just
  // fails open (nothing dropped).
  if (type === "opencode-free") await ensureOpencodeCatalog();

  try {
    const res = await fetch(url);
    if (!res.ok) {
      return NextResponse.json({ data: [] });
    }
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    // Object-shaped catalogs (minimax-code's {providers:[…]}) ride in as a
    // single-element array so every filter keeps an array input contract.
    const data = filter(Array.isArray(raw) ? raw : typeof raw === "object" && raw !== null ? [raw] : []);
    return NextResponse.json({ data });
  } catch {
    return NextResponse.json({ data: [] });
  }
}
