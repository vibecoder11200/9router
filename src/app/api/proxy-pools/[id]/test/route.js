import { NextResponse } from "next/server";
import { getProxyPoolById, updateProxyPool } from "@/models";
import { testProxyUrl } from "@/lib/network/proxyTest";
import { fetch as undiciFetch } from "undici";

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

    // Proxy group: test each entry independently and aggregate the results.
    // The group itself has no single proxyUrl (it is intentionally empty);
    // the entries hold the actual proxies. We probe every non-"direct",
    // non-cooled-down entry and report how many passed.
    if (proxyPool.isGroup === true && Array.isArray(proxyPool.entries)) {
      const now = Date.now();
      const entriesToTest = proxyPool.entries.filter(
        (e) => e && e.isActive !== false && e.type !== "direct" && e.proxyUrl
      );

      if (entriesToTest.length === 0) {
        const emptyNow = new Date().toISOString();
        await updateProxyPool(id, {
          testStatus: "error",
          lastTestedAt: emptyNow,
          lastError: "No proxy entries to test (group is empty or direct-only)",
          isActive: false,
        });
        return NextResponse.json({
          ok: false,
          status: 400,
          error: "No proxy entries to test",
          testedAt: emptyNow,
        });
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

      const updatedEntries = proxyPool.entries.map((e) => {
        const r = results.find((x) => x.id === e.id);
        if (!r) return e;
        if (r.ok) {
          return { ...e, lastError: null, cooldownUntil: null };
        }
        const until = now + 60 * 1000; // 60s cooldown on failed entries
        return {
          ...e,
          lastError: (r.error || `status ${r.status}`).slice(0, 300),
          cooldownUntil: until,
        };
      });

      await updateProxyPool(id, {
        entries: updatedEntries,
        testStatus: okOverall ? "active" : "error",
        lastTestedAt: nowIso,
        lastError: okOverall
          ? null
          : (failed[0]?.error || "All proxy entries failed"),
        isActive: okOverall,
      });

      return NextResponse.json({
        ok: okOverall,
        status: okOverall ? 200 : 502,
        statusText: okOverall ? "OK" : "All entries failed",
        error: okOverall ? null : (failed[0]?.error || "All entries failed"),
        elapsedMs: results.reduce((m, r) => Math.max(m, r.elapsedMs || 0), 0),
        testedAt: nowIso,
        group: {
          total: entriesToTest.length,
          passed: passed.length,
          failed: failed.length,
          results,
        },
      });
    }

    const result = proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno"
      ? await testVercelRelay(proxyPool.proxyUrl)
      : await testProxyUrl({ proxyUrl: proxyPool.proxyUrl });
    const now = new Date().toISOString();

    await updateProxyPool(id, {
      testStatus: result.ok ? "active" : "error",
      lastTestedAt: now,
      lastError: result.ok ? null : (result.error || `Proxy test failed with status ${result.status}`),
      isActive: result.ok,
    });

    return NextResponse.json({
      ok: result.ok,
      status: result.status,
      statusText: result.statusText || null,
      error: result.error || null,
      elapsedMs: result.elapsedMs || 0,
      testedAt: now,
    });
  } catch (error) {
    console.log("Error testing proxy pool:", error);
    return NextResponse.json({ error: "Failed to test proxy pool" }, { status: 500 });
  }
}
