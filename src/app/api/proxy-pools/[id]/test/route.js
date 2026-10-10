import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool, mutateProxyPoolEntries } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";
import { runHealthCheck } from "@/lib/xray/manager";

// Debounce for kicking the v2go health-check/auto-rotate from repeated test
// clicks — each runHealthCheck may await a blue-green switchConfig.
let lastManagedHealthKickAt = 0;
const MANAGED_HEALTH_KICK_DEBOUNCE_MS = 10_000;

// A pool is auto-deactivated only after this many CONSECUTIVE failed tests —
// never on a single blip (P1/N1). Manual UI toggle always wins over the streak.
const FAIL_STREAK_DEACTIVATE = 3;

function nextFailStreak(pool, ok) {
  return ok ? 0 : (Number(pool?.failStreak) || 0) + 1;
}

function isManagedV2GoPool(id, pool) {
  return id === "v2go-xray-managed" || pool?._v2goManaged === true;
}

async function testVercelRelay(relayUrl, timeoutMs = 10000) {
  const controller = new AbortController();
  const startedAt = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
      },
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/proxy-pools/[id]/test - Test proxy pool entry
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const proxyPool = await getProxyPoolById(id);

    if (!proxyPool) {
      return NextResponse.json({ error: "Proxy pool not found" }, { status: 404 });
    }

    const isManagedPool = isManagedV2GoPool(id, proxyPool);

    // Proxy group: test each entry independently and aggregate the results.
    // The group itself has no single proxyUrl (it is intentionally empty);
    // the entries hold the actual proxies. We probe every non-"direct",
    // non-cooled-down entry and report how many passed.
    if (proxyPool.isGroup === true && Array.isArray(proxyPool.entries)) {
      const now = Date.now();
      const entriesToTest = proxyPool.entries.filter(
        (e) => e && e.isActive !== false && e.type !== "direct" && e.proxyUrl
      );

      // "No entries to test" is a configuration problem, not a test failure —
      // it must never deactivate the pool (P1/N1).
      if (entriesToTest.length === 0) {
        const emptyNow = new Date().toISOString();
        await updateProxyPool(id, {
          testStatus: "error",
          lastTestedAt: emptyNow,
          lastError: "No proxy entries to test (group is empty or direct-only)",
        });
        return NextResponse.json({
          ok: false,
          status: 400,
          error: "No proxy entries to test",
          testedAt: emptyNow,
        }, { status: 400 });
      }

      const results = await Promise.all(
        entriesToTest.map(async (entry) => {
          const r = await testProxyUrl({ proxyUrl: entry.proxyUrl });
          return { id: entry.id, name: entry.name, ...r };
        })
      );

      const passed = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      // Group is "active" if at least one entry is reachable; cooldown the
      // failed entries so rotation can skip them at runtime.
      const okOverall = passed.length > 0;
      const nowIso = new Date().toISOString();
      const failStreak = nextFailStreak(proxyPool, okOverall);
      const cooldownUntil = now + 60 * 1000; // 60s cooldown on failed entries

      // Per-entry cooldowns as ONE transactional delta-write (N2): a stale
      // whole-entries snapshot could clobber a concurrent runtime cooldown.
      await mutateProxyPoolEntries(id, (entries) =>
        entries.map((e) => {
          const r = results.find((x) => x.id === e.id);
          if (!r) return e;
          if (r.ok) {
            return { ...e, lastError: null, cooldownUntil: null };
          }
          return {
            ...e,
            lastError: (r.error || `status ${r.status}`).slice(0, 300),
            cooldownUntil,
          };
        })
      );

      const updates = {
        testStatus: okOverall ? "active" : "error",
        lastTestedAt: nowIso,
        lastError: okOverall
          ? null
          : (failed[0]?.error || "All proxy entries failed"),
        failStreak,
      };
      // Streak-based deactivation only (P1/N1): a single failed test advances
      // the streak but never deactivates; a passing test re-activates.
      if (isManagedPool) {
        if (!okOverall) {
          updates.lastError = `${updates.lastError} — v2go node unreachable, auto-rotation triggered; re-test in a few seconds`;
          if (Date.now() - lastManagedHealthKickAt > MANAGED_HEALTH_KICK_DEBOUNCE_MS) {
            lastManagedHealthKickAt = Date.now();
            runHealthCheck().catch((e) =>
              console.warn("[proxy-pools] managed-pool test kick of health check failed:", e?.message || e)
            );
          }
        }
      } else if (okOverall) {
        updates.isActive = true;
      } else if (failStreak >= FAIL_STREAK_DEACTIVATE) {
        updates.isActive = false;
        updates.lastError = `${updates.lastError} — deactivated after ${failStreak} consecutive failed tests`;
      }
      await updateProxyPool(id, updates);

      return NextResponse.json({
        ok: okOverall,
        status: okOverall ? 200 : 502,
        statusText: okOverall ? "OK" : "All entries failed",
        error: okOverall ? null : (failed[0]?.error || "All entries failed"),
        elapsedMs: results.reduce((m, r) => Math.max(m, r.elapsedMs || 0), 0),
        testedAt: nowIso,
        failStreak,
        group: {
          total: entriesToTest.length,
          passed: passed.length,
          failed: failed.length,
          results,
        },
      });
    }

    const result = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno" || proxyPool.type === "netlify"
      ? await testVercelRelay(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    const now = new Date().toISOString();
    const failStreak = nextFailStreak(proxyPool, result.ok);

    const updates = {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      failStreak,
    };

    // Managed v2go pool: its lifecycle belongs to the xray manager. A failed
    // probe must NOT deactivate it — an inactive pool makes bound connections
    // fall back to DIRECT (leaking the server IP under strictProxy intent).
    // Instead, surface the error and kick the health-check/auto-rotate
    // machinery in the background: it re-probes authoritatively and
    // blue-green-switches to a healthy node when "Auto-rotate" is enabled.
    if (isManagedPool) {
      if (!result.ok) {
        updates.lastError = `${updates.lastError} — v2go node unreachable, auto-rotation triggered; re-test in a few seconds`;
        if (Date.now() - lastManagedHealthKickAt > MANAGED_HEALTH_KICK_DEBOUNCE_MS) {
          lastManagedHealthKickAt = Date.now();
          runHealthCheck().catch((e) =>
            console.warn("[proxy-pools] managed-pool test kick of health check failed:", e?.message || e)
          );
        }
      }
    } else if (result.ok) {
      // A passing (user-triggered) test re-activates an auto-deactivated pool.
      updates.isActive = true;
    } else if (failStreak >= FAIL_STREAK_DEACTIVATE) {
      // Auto-deactivate only after N consecutive failures — never one (P1/N1).
      updates.isActive = false;
      updates.lastError = `${updates.lastError} — deactivated after ${failStreak} consecutive failed tests`;
    }

    await updateProxyPool(id, updates);

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      testedAt: now,
      failStreak,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
