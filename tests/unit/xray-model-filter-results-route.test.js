// v0.6.91 phase 3 — persistent results API: repo/route + single-truth parity.
//
// The JS classifier (classifyPersistedFilterError) and the SQL fragments
// (getFilterErrorFragmentSql) are two views of one taxonomy — this suite
// proves they agree over a real temp sqlite DB (adapter-mocked LIKE
// semantics would make parity self-fulfilling, red-team F5):
//   - every fixture row matches EXACTLY ONE SQL fragment, and JS(persisted)
//     returns the same class id
//   - fragments are pairwise-disjoint over the whole table
//   - soft-deleted configs never resurrect through the join
//   - exitIp is opt-in; spawn has an empty fragment; summary scans full text
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let driver;
let repo;
let frag;
let resultsRoute;
let configsRoute;

const MODEL = "oc/beam-free";
const FRAG_CLASSES = [
  "usable", "quota-429", "edge-ban", "tunnel", "upstream-net",
  "tunnel-check", "upstream-http", "timeout", "spawn", "other",
];

// Fixture corpus — every probe-producing path's wording (plan phase-2/3 tables)
const CORPUS = [
  { key: "usable", error: null, status: 200, expect: "usable" },
  { key: "quota429", error: "[429]: FreeUsageLimitError", status: 429, expect: "quota-429" },
  { key: "quotaText", error: "rate limited: FreeUsageLimitError", status: null, expect: "quota-429" },
  { key: "timeout1", error: "Probe timed out after 20000ms", status: null, expect: "timeout" },
  { key: "timeout2", error: "connect ETIMEDOUT 1.2.3.4:443", status: null, expect: "timeout" },
  { key: "timeout3", error: "TIMEOUT after 5s", status: null, expect: "timeout" },
  { key: "tunnelAnnotated", error: "[502]: [ProxyFetch] Proxy required but failed (strictProxy=true): connect ECONNREFUSED 1.2.3.4:443 (cause: ETIMEDOUT)", status: 502, expect: "tunnel" },
  { key: "tunnelRefusal1", error: "[ProxyFetch] strictProxy=true but connection proxy could not be resolved; refusing direct fetch", status: null, expect: "tunnel" },
  { key: "tunnelRefusal2", error: "[ProxyFetch] Proxy required but none resolved (strictProxy=true)", status: null, expect: "tunnel" },
  { key: "upstreamNet", error: "[502]: bun child upstream fetch failed: socket hang up", status: 502, expect: "upstream-net" },
  { key: "tunnelCheck", error: "Free-lane model — tunnel connectivity check failed (chat probe skipped)", status: 0, expect: "tunnel-check" },
  { key: "edgeBan", error: "cloudflare edge ip block (exit ip banned)", status: 403, expect: "edge-ban" },
  { key: "upstreamHttp", error: "model gate html page", status: 403, expect: "upstream-http" },
  { key: "upstreamHttp503", error: "No active credentials for provider", status: 503, expect: "upstream-http" },
  { key: "trueOther", error: "No active credentials for provider", status: null, expect: "other" },
];

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-mfresults-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/modelFilterResultsRepo.js");
  frag = await import("@/lib/xray/modelFilterErrors.js");
  resultsRoute = await import("../../src/app/api/xray/configs/model-filter/results/route.js");
  configsRoute = await import("../../src/app/api/xray/configs/route.js");
  driver = await import("@/lib/db/driver.js");

  // Configs: 3 active + 1 inactive + 1 soft-deleted (tombstone)
  const mk = (id, name, host, isActive) => ({
    id, link: `vless://u@${host}:443?type=ws#${name}`, name, protocol: "vless",
    country: "US", host, port: 443, isActive,
  });
  await db.upsertXrayConfig(mk("cfg-a", "alpha-node", "a.example.com", true));
  // One config per corpus entry — the table's PK is (configId, model), so
  // multiple rows on the SAME config would collapse to the last write.
  for (let i = 0; i < CORPUS.length; i++) {
    await db.upsertXrayConfig(mk(`cfg-${String(i).padStart(2, "0")}`, `node-${CORPUS[i].key}`, `${CORPUS[i].key}.example.com`, true));
  }
  await db.upsertXrayConfig(mk("cfg-i", "delta-inactive", "d.example.com", true));
  await db.upsertXrayConfig(mk("cfg-x", "epsilon-doomed", "e.example.com", true));
  // flip cfg-i inactive + tombstone cfg-x (the xrayRepo soft delete)
  const xrayRepo = await import("@/lib/db/repos/xrayRepo.js");
  const adb = await driver.getAdapter();
  await db.updateSettings({ xrayModelFilterModel: MODEL });
  adb.run(`UPDATE xrayConfigs SET isActive = 0 WHERE id = 'cfg-i'`);
  await xrayRepo.tombstoneXrayConfig("cfg-x");

  // Result rows: one corpus row per config; +1 row on the inactive
  // config; +1 row on the tombstoned config; +1 row on a second model.
  let seq = 0;
  const up = (configId, model, row) => repo.upsertModelFilterResult({
    configId,
    model,
    ok: row.ok ?? false,
    latencyMs: 100 + seq,
    status: row.status ?? null,
    exitIp: `203.0.113.${(seq % 250) + 1}`,
    error: row.error ?? null,
    testedAt: new Date(Date.UTC(2026, 10, 14, 10, 0, seq++ % 60)).toISOString(),
  });

  for (let i = 0; i < CORPUS.length; i++) {
    const entry = CORPUS[i];
    await up(`cfg-${String(i).padStart(2, "0")}`, MODEL, { ...entry, ok: entry.expect === "usable" });
  }
  await up("cfg-i", MODEL, { error: "Probe timed out after 20000ms", status: null }); // inactive-config row
  await up("cfg-x", MODEL, { error: "[429]: FreeUsageLimitError", status: 429 }); // tombstoned-config row
  await up("cfg-00", "other/model", { error: "Probe timed out after 20000ms", status: null }); // other-model row
});

afterAll(() => {
  if (tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows: the adapter may still hold the sqlite handle — leave the temp dir.
    }
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("parity — JS classifier vs SQL fragments (real sqlite)", () => {
  it("every corpus row matches exactly one fragment; JS agrees with SQL", async () => {
    const adb = await driver.getAdapter();
    const rows = adb.all(`SELECT configId, model, ok, status, error FROM xrayModelFilterResults WHERE model = ?`, [MODEL]);
    const fragmentClasses = frag.FILTER_ERROR_BASE_PREDICATES.map((p) => p.cls);
    let checked = 0;
    for (const row of rows) {
      // SQL: which fragments match this row?
      const matches = [];
      for (const cls of fragmentClasses) {
        const sql = `SELECT COUNT(*) AS n FROM xrayModelFilterResults r WHERE r.configId = ? AND r.model = ? AND ${frag.getFilterErrorFragmentSql(cls)}`;
        const n = Number(adb.get(sql, [row.configId, row.model])?.n) || 0;
        if (n > 0) matches.push(cls);
      }
      // "other" fragment (complement of all bases)
      const otherN = Number(adb.get(
        `SELECT COUNT(*) AS n FROM xrayModelFilterResults r WHERE r.configId = ? AND r.model = ? AND ${frag.FILTER_ERROR_SQL_OTHER_FRAGMENT}`,
        [row.configId, row.model],
      )?.n) || 0;
      if (otherN > 0) matches.push("other");

      expect(matches, `${row.configId} "${(row.error || "").slice(0, 60)}" matched: ${matches.join(",")}`).toHaveLength(1);

      // JS persisted classifier must return the same class
      const jsCls = frag.classifyPersistedFilterError({ ok: row.ok === 1, status: row.status, error: row.error });
      expect(jsCls).toBe(matches[0]);
      checked += 1;
    }
    expect(checked).toBeGreaterThanOrEqual(14); // corpus + scoping rows for MODEL
  });

  it("fragments are pairwise-disjoint over the WHOLE table", async () => {
    const adb = await driver.getAdapter();
    const classes = [...frag.FILTER_ERROR_BASE_PREDICATES.map((p) => p.cls), "other"];
    for (let i = 0; i < classes.length; i++) {
      for (let j = i + 1; j < classes.length; j++) {
        const a = classes[i] === "other" ? frag.FILTER_ERROR_SQL_OTHER_FRAGMENT : frag.getFilterErrorFragmentSql(classes[i]);
        const b = frag.getFilterErrorFragmentSql(classes[j]);
        const sql = `SELECT COUNT(*) AS n FROM xrayModelFilterResults r WHERE (${a}) AND (${b})`;
        const n = Number(adb.get(sql)?.n) || 0;
        expect(n, `fragments ${classes[i]} ∩ ${classes[j]} must be empty`).toBe(0);
      }
    }
  });

  it("summary scan (view=summary) counts full-text classes and scopes correctly", async () => {
    const req = (q) => new Request(`http://localhost/api/xray/configs/model-filter/results?view=summary&model=${encodeURIComponent(MODEL)}${q}`);
    const res = await resultsRoute.GET(req(""));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.scope).toEqual({ model: MODEL, minTestedAt: null, activeOnly: true });

    // default activeOnly=true: inactive + tombstoned configs' rows excluded
    const expected = {};
    for (const c of CORPUS) {
      expected[c.expect] = (expected[c.expect] || 0) + 1;
    }
    expect(data.byClass).toEqual(expect.objectContaining(expected));
    expect(data.total).toBe(CORPUS.length);
    expect(data.lastTestedAt).toBeTruthy();

    // active=0 widens to inactive configs (still excludes tombstoned)
    const resWide = await resultsRoute.GET(req("&active=0"));
    const wide = await resWide.json();
    expect(wide.total).toBe(CORPUS.length + 1); // + the inactive-config row
    expect(wide.byClass["timeout"]).toBe(expected["timeout"] + 1);

    // minTestedAt scoping: only rows after the cutoff
    const mid = new Date(Date.UTC(2026, 10, 14, 10, 0, 7)).toISOString();
    const resScoped = await resultsRoute.GET(req(`&minTestedAt=${encodeURIComponent(mid)}`));
    const scoped = await resScoped.json();
    expect(scoped.total).toBeLessThan(CORPUS.length);
    expect(scoped.scope.minTestedAt).toBe(mid);
  });
});

describe("rows view — repo + route", () => {
  it("listFilterResultsJoined returns identity + verdicts, error omitted for ok rows", async () => {
    const rows = await repo.listFilterResultsJoined({ model: MODEL, pageSize: 100 });
    expect(rows.length).toBe(CORPUS.length);
    const okRow = rows.find((r) => r.ok === true);
    expect(okRow.error).toBeNull();
    expect(okRow.exitIp).toBeUndefined(); // opt-in only
    const failRow = rows.find((r) => r.ok === false && r.error);
    expect(typeof failRow.error).toBe("string");
    expect(rows.every((r) => typeof r.name === "string" && typeof r.host === "string")).toBe(true);
    // newest first
    const times = rows.map((r) => r.testedAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("soft-deleted configs never resurrect; inactive excluded by default", async () => {
    const rows = await repo.listFilterResultsJoined({ model: MODEL, pageSize: 100, activeOnly: false });
    expect(rows.some((r) => r.configId === "cfg-x")).toBe(false); // tombstoned
    expect(rows.some((r) => r.configId === "cfg-i")).toBe(true); // inactive reachable with activeOnly=false
    const rowsDefault = await repo.listFilterResultsJoined({ model: MODEL, pageSize: 100 });
    expect(rowsDefault.some((r) => r.configId === "cfg-i")).toBe(false);
  });

  it("exitIp appears only with includeExitIp (opt-in pin)", async () => {
    const rows = await repo.listFilterResultsJoined({ model: MODEL, pageSize: 100, includeExitIp: true, activeOnly: false });
    const withIp = rows.filter((r) => r.exitIp);
    expect(withIp.length).toBeGreaterThan(0);
    expect(withIp.every((r) => r.ok === false)).toBe(true);
  });

  it("class filter narrows rows; spawn is empty; other is the residual", async () => {
    const tunnelRows = await repo.listFilterResultsJoined({ model: MODEL, errorClass: "tunnel", pageSize: 100 });
    expect(tunnelRows.length).toBe(3); // annotated + 2 refusals
    expect(tunnelRows.every((r) => /proxy required|refusing direct fetch|strictproxy=/i.test(r.error))).toBe(true);

    const spawnRows = await repo.listFilterResultsJoined({ model: MODEL, errorClass: "spawn", pageSize: 100 });
    expect(spawnRows).toEqual([]);

    const otherRows = await repo.listFilterResultsJoined({ model: MODEL, errorClass: "other", pageSize: 100 });
    expect(otherRows.length).toBe(1);
    expect(otherRows[0].error).toContain("No active credentials");

    const usableRows = await repo.listFilterResultsJoined({ model: MODEL, errorClass: "usable", pageSize: 100 });
    expect(usableRows.length).toBe(1);
  });

  it("search matches name/host/error literally (LIKE-escaped)", async () => {
    const byName = await repo.listFilterResultsJoined({ model: MODEL, search: "node-usable", pageSize: 100 });
    expect(byName.length).toBeGreaterThan(0);
    expect(byName.every((r) => r.name === "node-usable")).toBe(true);
    // % in the search text must not act as a wildcard
    const literal = await repo.listFilterResultsJoined({ model: MODEL, search: "100% match", pageSize: 100 });
    expect(literal).toEqual([]);
    const byError = await repo.listFilterResultsJoined({ model: MODEL, search: "FreeUsageLimitError", pageSize: 100 });
    expect(byError.length).toBe(2); // quota429 + quotaText fixtures carry the string
  });

  it("pagination clamps pageSize to 200 and pages coherently", async () => {
    const page1 = await repo.listFilterResultsJoined({ model: MODEL, page: 1, pageSize: 5 });
    const page2 = await repo.listFilterResultsJoined({ model: MODEL, page: 2, pageSize: 5 });
    expect(page1.length).toBe(5);
    expect(page2.length).toBe(Math.min(5, CORPUS.length - 5));
    const ids1 = page1.map((r) => r.configId + r.testedAt);
    const ids2 = page2.map((r) => r.configId + r.testedAt);
    for (const id of ids2) expect(ids1).not.toContain(id);
    const clamped = await repo.listFilterResultsJoined({ model: MODEL, page: 1, pageSize: 99999 });
    expect(clamped.length).toBeLessThanOrEqual(200);
    const total = await repo.countFilterResultsJoined({ model: MODEL });
    expect(total).toBe(CORPUS.length);
  });

  it("route GET serves rows + summary envelopes (real repo)", async () => {
    const mkReq = (q) => new Request(`http://localhost/api/xray/configs/model-filter/results?model=${encodeURIComponent(MODEL)}&${q}`);
    const res = await resultsRoute.GET(mkReq("view=rows&page=1&pageSize=5"));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.rows.length).toBe(5);
    expect(data.total).toBe(CORPUS.length);
    expect(data.totalPages).toBe(Math.ceil(CORPUS.length / 5));
    expect(data.page).toBe(1);

    const summaryRes = await resultsRoute.GET(mkReq("view=summary"));
    const summary = await summaryRes.json();
    expect(summary.byClass.usable).toBe(1);
    expect(summary.byClass["edge-ban"]).toBe(1);
    expect(summary.total).toBe(CORPUS.length);
  });

  it("empty cache state returns zeroed summary + empty rows", async () => {
    const res = await resultsRoute.GET(new Request(`http://localhost/api/xray/configs/model-filter/results?model=no-such-model&view=summary`));
    const data = await res.json();
    expect(data.total).toBe(0);
    expect(Object.values(data.byClass).every((v) => v === 0)).toBe(true);
    const resRows = await resultsRoute.GET(new Request(`http://localhost/api/xray/configs/model-filter/results?model=no-such-model`));
    const rows = await resRows.json();
    expect(rows.rows).toEqual([]);
    expect(rows.total).toBe(0);
  });
});

describe("configs route badge payload — errorClass (phase 4)", () => {
  it("badge carries errorClass (persisted-domain) without raw error text", async () => {
    const res = await configsRoute.GET(new Request("http://localhost/api/xray/configs"));
    const data = await res.json();
    expect(res.status).toBe(200);
    const withResult = data.configs.filter((c) => c.modelFilterResult);
    expect(withResult.length).toBeGreaterThan(0);
    for (const c of withResult) {
      const b = c.modelFilterResult;
      expect(b).toHaveProperty("errorClass");
      if (b.ok) expect(b.errorClass).toBe("usable");
      else expect(FRAG_CLASSES).toContain(b.errorClass);
      // raw error text must NOT leak into the servers-table payload
      expect(b).not.toHaveProperty("error");
    }
    // a known failed row: the usable fixture's class must be exact
    const usable = withResult.find((c) => c.modelFilterResult.ok === true);
    expect(usable.modelFilterResult.errorClass).toBe("usable");
  });
});
