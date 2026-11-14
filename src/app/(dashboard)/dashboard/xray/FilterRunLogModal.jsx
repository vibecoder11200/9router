"use client";

// FilterRunLogModal (v0.6.91 phase 4) — full drill-in over the pool's
// persistent filter verdicts via GET /api/xray/configs/model-filter/results
// (phase 3). Two labeled modes:
//   - "Last run": scoped by the last finished run's startedAt (minTestedAt) —
//     shows the probe results WRITTEN DURING that run window. Its counts
//     usually match the dashboard chips but are not guaranteed identical:
//     cached-reused verdicts keep their old testedAt (excluded here, counted
//     in the chips), pruned configs lose their rows, managedRotation writes
//     landing in the window leak in, and ambiguous non-429 HTTP rows differ
//     by the documented tunnelOk caveat.
//   - "All verdicts": everything persisted for the model (spans runs, incl.
//     managedRotation writes) — explicitly labeled as such.
// Fetch hygiene (plan red-team F13): AbortController per fetch + a monotonic
// sequence number — last-STARTED response wins, never last-RESOLVED.
// Dataset changes (mode/class/search/pageSize/exitIp) reset the page to 1
// and the page shown is clamped to totalPages (red-team F12).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "@/shared/components/Modal";
import Pagination from "@/shared/components/Pagination";
import { Badge, Button } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  FILTER_ERROR_LABELS,
  FILTER_ERROR_VARIANTS,
  classifyPersistedFilterError,
  errorBreakdownEntries,
} from "@/lib/xray/modelFilterErrors.js";

function timeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const MODE_LABELS = {
  lastrun: "Last run",
  all: "All verdicts",
};

export default function FilterRunLogModal({ isOpen, onClose, lastRun, live }) {
  const [mode, setMode] = useState(lastRun ? "lastrun" : "all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [classFilter, setClassFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [includeExitIp, setIncludeExitIp] = useState(false);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const { copied, copy } = useCopyToClipboard();
  const fetchSeqRef = useRef(0);
  const abortRef = useRef(null);

  const running = live?.status === "running";
  const minTestedAt = mode === "lastrun" && lastRun?.startedAt ? lastRun.startedAt : null;
  // "All verdicts" widens to inactive-but-not-deleted configs (History view);
  // "Last run" keeps the default activeOnly so its counts match the chips.
  const activeOnly = mode === "lastrun";

  // debounce search → 300ms
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // dataset-affecting changes reset the page (red-team F12)
  useEffect(() => {
    setPage(1);
  }, [mode, classFilter, search, pageSize, includeExitIp]);

  const fetchData = useCallback(async () => {
    if (!isOpen) return;
    const seq = ++fetchSeqRef.current;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const params = new URLSearchParams();
    if (mode === "lastrun" && lastRun?.startedAt) params.set("minTestedAt", lastRun.startedAt);
    if (mode === "all") params.set("active", "0");
    if (classFilter !== "all") params.set("class", classFilter);
    if (search) params.set("name", search);
    if (includeExitIp) params.set("includeExitIp", "1");
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));

    setLoading(true);
    setLoadError(null);
    try {
      const [rowsRes, summaryRes] = await Promise.all([
        fetch(`/api/xray/configs/model-filter/results?${params.toString()}`, { signal: controller.signal }),
        fetch(
          `/api/xray/configs/model-filter/results?view=summary&${new URLSearchParams({
            ...(mode === "lastrun" && lastRun?.startedAt ? { minTestedAt: lastRun.startedAt } : {}),
            ...(mode === "all" ? { active: "0" } : {}),
          }).toString()}`,
          { signal: controller.signal },
        ),
      ]);
      if (seq !== fetchSeqRef.current) return; // stale — a newer fetch started
      if (!rowsRes.ok || !summaryRes.ok) throw new Error(`HTTP ${rowsRes.status}/${summaryRes.status}`);
      const rowsData = await rowsRes.json();
      const summaryData = await summaryRes.json();
      if (seq !== fetchSeqRef.current) return;
      setRows(Array.isArray(rowsData.rows) ? rowsData.rows : []);
      setTotal(rowsData.total || 0);
      setTotalPages(Math.max(1, rowsData.totalPages || 1));
      setSummary(summaryData);
    } catch (e) {
      if (seq !== fetchSeqRef.current || e?.name === "AbortError") return;
      setLoadError(e.message || "fetch failed");
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [isOpen, mode, classFilter, search, includeExitIp, page, pageSize, lastRun?.startedAt]);

  useEffect(() => {
    fetchData();
    return () => {
      // cancel in-flight fetch when the modal closes or deps change
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchData]);

  // total/totalPages can shrink mid-session (clear-cache); clamp the page
  // STATE so the next fetch agrees with what Pagination displays.
  useEffect(() => {
    if (page > totalPages) setPage(Math.max(1, totalPages));
  }, [page, totalPages]);
  const safePage = Math.min(page, totalPages);

  const classChips = useMemo(() => {
    if (!summary?.byClass) return [];
    return errorBreakdownEntries(summary.byClass);
  }, [summary]);

  const copySummaryTsv = useCallback(() => {
    const lines = ["class\tcount"];
    for (const { cls, count } of classChips) lines.push(`${cls}\t${count}`);
    lines.push("");
    lines.push(["server", "host", "country", "class", "status", "latencyMs", "testedAt", "error"].join("\t"));
    for (const r of rows) {
      const cls = r.ok ? "usable" : classifyPersistedFilterError({ ok: r.ok, status: r.status, error: r.error });
      lines.push([
        r.name || "", r.host || "", r.country || "",
        cls,
        r.status ?? "", r.latencyMs ?? "", r.testedAt || "",
        (r.error || "").replace(/\t/g, " "),
      ].join("\t"));
    }
    copy(lines.join("\n"), "summary-tsv");
  }, [classChips, rows, copy]);

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Filter run log"
      size="full"
      footer={
        <div className="flex items-center justify-between gap-3 flex-wrap w-full">
          {running ? (
            <div className="text-xs text-text-muted flex items-center gap-2 flex-wrap">
              <Badge variant="warning">run in progress</Badge>
              {live.tested || 0} tested · {live.passed || 0} usable · {live.failed || 0} failed
              {errorBreakdownEntries(live.errorBreakdown).map(({ cls, count, label, variant }) => (
                <Badge key={cls} variant={variant}>{count}× {label}</Badge>
              ))}
            </div>
          ) : (
            <div className="text-xs text-text-muted">
              {mode === "lastrun" && lastRun
                ? `Probe results written during the run started ${timeAgo(lastRun.startedAt)} on ${lastRun.model || "?"} (cached/pruned rows may differ from the chips)`
                : "All persisted verdicts for the configured model — spans runs, incl. auto-rotation"}
            </div>
          )}
          <div className="flex items-center gap-2">
            {loading && <span className="text-xs text-text-muted">Loading…</span>}
            <Button size="sm" variant="ghost" onClick={copySummaryTsv}>
              {copied === "summary-tsv" ? "Copied!" : "Copy summary"}
            </Button>
            <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {/* mode toggle + controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {(["lastrun", "all"]).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? "primary" : "ghost"}
              onClick={() => setMode(m)}
              disabled={m === "lastrun" && !lastRun}
            >
              {m === "lastrun" && lastRun ? `${MODE_LABELS[m]} (${lastRun.tested || 0} tested)` : MODE_LABELS[m]}
            </Button>
          ))}
          <label className="flex items-center gap-1.5 text-xs text-text-muted ml-auto">
            <input
              type="checkbox"
              checked={includeExitIp}
              onChange={(e) => setIncludeExitIp(e.target.checked)}
            />
            show exit IPs
          </label>
        </div>

        {/* class chips + search */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant={classFilter === "all" ? "primary" : "ghost"} onClick={() => setClassFilter("all")}>
            all{summary ? ` (${summary.total})` : ""}
          </Button>
          {classChips.map(({ cls, count, label, variant }) => (
            <Button
              key={cls}
              size="sm"
              variant={classFilter === cls ? "primary" : "ghost"}
              onClick={() => setClassFilter(cls)}
            >
              {label} ({count})
            </Button>
          ))}
          <input
            className="ml-auto text-sm border rounded px-2 py-1 bg-transparent"
            placeholder="Search name / host / error…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        {/* table */}
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-xs">
            <thead className="text-left text-text-muted border-b">
              <tr>
                <th className="py-2 px-3">Server</th>
                <th className="py-2 px-3">Country</th>
                <th className="py-2 px-3">Class</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Latency</th>
                <th className="py-2 px-3">Tested</th>
                {includeExitIp && <th className="py-2 px-3">Exit IP</th>}
                <th className="py-2 px-3">Error</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody>
              {loadError && (
                <tr><td colSpan={includeExitIp ? 9 : 8} className="py-4 px-3 text-center text-red-500">Failed to load: {loadError}</td></tr>
              )}
              {!loadError && rows.length === 0 && !loading && (
                <tr><td colSpan={includeExitIp ? 9 : 8} className="py-4 px-3 text-center text-text-muted">
                  No verdicts match — the cache may have been cleared or the filters are too narrow.
                </td></tr>
              )}
              {rows.map((r) => {
                // Client-side classification mirrors the route's summary scan
                // (same persisted-domain classifier — single truth).
                const rowCls = r.ok ? "usable" : classifyPersistedFilterError({ ok: r.ok, status: r.status, error: r.error });
                return (
                  <tr key={`${r.configId}-${r.model}`} className="border-b last:border-0 align-top">
                    <td className="py-2 px-3 max-w-xs">
                      <div className="truncate font-medium">{r.name || r.host || r.configId}</div>
                      <div className="truncate text-text-muted">{r.host}</div>
                      {r.isActive === false && <Badge>inactive</Badge>}
                    </td>
                    <td className="py-2 px-3">{r.country || "—"}</td>
                    <td className="py-2 px-3">
                      <Badge variant={FILTER_ERROR_VARIANTS[rowCls] || "warning"}>
                        {FILTER_ERROR_LABELS[rowCls] || rowCls}
                      </Badge>
                    </td>
                    <td className="py-2 px-3">{r.status ?? "—"}</td>
                    <td className="py-2 px-3">{r.latencyMs != null && r.latencyMs >= 0 ? `${r.latencyMs}ms` : "—"}</td>
                    <td className="py-2 px-3" title={r.testedAt || ""}>{timeAgo(r.testedAt)}</td>
                    {includeExitIp && <td className="py-2 px-3 font-mono">{r.exitIp || "—"}</td>}
                    <td className="py-2 px-3 max-w-md whitespace-pre-wrap break-words">{r.error || "—"}</td>
                    <td className="py-2 px-3">
                      {r.error && (
                        <Button size="sm" variant="ghost" onClick={() => copy(r.error, `row-${r.configId}`)}>
                          {copied === `row-${r.configId}` ? "Copied!" : "Copy"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pagination
          currentPage={safePage}
          pageSize={pageSize}
          totalItems={total}
          onPageChange={(p) => setPage(p)}
          onPageSizeChange={(s) => setPageSize(s)}
        />
      </div>
    </Modal>
  );
}
