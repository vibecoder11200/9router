import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isTrustedInternalRequest,
  getApiKeyRow,
} from "../services/auth.js";
import { checkKeyBudget } from "../services/keyBudgets.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes, isStrikeBlocked } from "../services/antigravityQuota.js";
import { checkBreaker, recordFailure, recordSuccess } from "../services/circuitBreaker.js";
import { formatRetryAfter } from "open-sse/services/accountFallback.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities } from "open-sse/services/combo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { markProxyEntryCooldown } from "@/models";
import {
  isProxyRotatableError,
  proxyCooldownForError,
  groupHasAvailableEntry,
  isConnectionFailure,
} from "@/lib/network/proxyRotation.js";
import { getProxyPoolById } from "@/models";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { beginLiveModelTraffic, wrapLiveModelResponse } from "@/lib/xray/modelFilterTraffic.js";
import { triggerManagedRotationOnProxyError, waitForManagedRotationSettle, noteManagedPoolConnFailure } from "@/lib/xray/managedRotation.js";
import { MANAGED_POOL_ID } from "@/lib/xray/manager.js";
import { waitForSocksPortOpen } from "@/lib/xray/tester.js";
import { emitAlert, EVENT_TYPES, SEVERITY } from "@/lib/alerts";

// Max times a single request will retry after a managed-pool *connection*
// failure (SOCKS port down during a rotation's teardown/respawn window). These
// are transient infra errors, not account errors — we wait for the port to come
// back and retry the same account rather than burning it.
const MAX_MANAGED_CONN_RETRIES = 2;


/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey && !(await isTrustedInternalRequest(request))) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const keyRow = await getApiKeyRow(apiKey);
    const valid = !!keyRow && (keyRow.isActive === 1 || keyRow.isActive === true);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
    // Per-key budgets (phase 08): unbudgeted keys short-circuit before any
    // spend query; budgeted keys read fresh spend here (no cache). Inert
    // unless requireApiKey is on — this branch IS the enforcement point.
    const budgetResponse = await checkKeyBudget(apiKey, keyRow);
    if (budgetResponse) return budgetResponse;
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  const internalProbe = request?.headers?.get("x-9r-internal") === "xray-model-filter"
    || clientRawRequest?.headers?.["x-9r-internal"] === "xray-model-filter";
  const finishLiveTraffic = internalProbe ? null : beginLiveModelTraffic();
  const completeLiveTraffic = (response) => finishLiveTraffic
    ? wrapLiveModelResponse(response, finishLiveTraffic)
    : response;

  try {

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return completeLiveTraffic(bypassResponse.response || bypassResponse);

  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboModels = await getComboModels(modelStr);
  if (comboModels) {
    // Check for combo-specific strategy first, fallback to global
    const comboStrategies = settings.comboStrategies || {};
    const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return completeLiveTraffic(await handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      }));
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return completeLiveTraffic(await handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit
    }));
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return completeLiveTraffic(await handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    }));
  }

  return completeLiveTraffic(await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey));
  } catch (error) {
    finishLiveTraffic?.();
    throw error;
  }
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, comboVisited = new Set()) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    // C6 backstop: a combo whose members include itself (directly or via
    // another combo) would recurse through this branch forever. The combo API
    // rejects cycles on write, but pre-existing data or a racing edit can
    // still produce one at read time.
    if (comboVisited.has(modelStr)) {
      log.warn("CHAT", `Combo cycle detected at "${modelStr}" — refusing to recurse`);
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `Combo cycle detected at "${modelStr}"`);
    }
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      const nextVisited = new Set([...comboVisited, modelStr]);
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, nextVisited);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, nextVisited),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  // Proxy-group entries already tried this request (cleared per request, not
  // per account) — prevents re-picking a cooled-down entry within one rotation.
  const excludedProxyEntryIds = new Set();
  let lastError = null;
  let lastStatus = null;
  // True when the last failed attempt was a strict-proxy failure (pool
  // exhausted/errored, never the account itself) — drives the terminal 503
  // with a retry-after instead of a bare error body.
  let lastProxyExhausted = false;
  // Retries used so far for managed-pool connection failures (port-down during
  // rotation). Bounded by MAX_MANAGED_CONN_RETRIES per request.
  let managedConnRetries = 0;
  // Last known state of the SOCKS port during those retries. null = no retry
  // ran; true = port kept accepting connections (so the failure is NOT
  // teardown noise); false = port never came back.
  let managedConnPortOpen = null;
  // Circuit breaker (phase 06): shortest retry-after promised by a breaker
  // that denied a candidate this request. Infinity until one does; only the
  // all-candidates-denied terminal path reads it.
  let breakerRetryAfterMs = Infinity;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        try {
          emitAlert(EVENT_TYPES.ALL_ACCOUNTS_LOCKED, {
            severity: SEVERITY.CRITICAL,
            dedupKey: String(provider || "unknown"),
            title: "All accounts locked",
            body: `Every ${provider} account is locked/rate-limited (${model}): ${errorMsg}. Retry after ${credentials.retryAfterHuman || "cooldown"}.`,
          });
        } catch { /* alerts must never break the error path */ }
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      if (lastProxyExhausted) {
        // Every account was skipped for a dead strict pool — 503 with a short
        // retry-after (entries cool down in ~60s; never fetch direct).
        const retryAfter = new Date(Date.now() + 30_000).toISOString();
        log.warn("CHAT", `[${provider}/${model}] ${lastError || "All strict proxy pools exhausted"} (retry in 30s)`);
        return unavailableResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, `[${provider}/${model}] ${lastError || "All strict proxy pools exhausted"}`, retryAfter, "retry in 30s");
      }
      if (breakerRetryAfterMs !== Infinity) {
        // Every remaining candidate was skipped by an open breaker. The loop
        // has no access to modelLock's retry data, so it reports the shortest
        // breaker cooldown itself (error.js expects an ISO timestamp).
        const retryAfter = new Date(Date.now() + breakerRetryAfterMs).toISOString();
        const msg = `[${provider}/${model}] ${lastError || "All candidates skipped by circuit breaker"}`;
        log.warn("CHAT", `${msg} (${formatRetryAfter(retryAfter)})`);
        return unavailableResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, msg, retryAfter, formatRetryAfter(retryAfter));
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Strict-proxy failure (pool exhausted / resolution error): never direct —
    // treat as a failed ACCOUNT attempt, exclude it, and let the loop pick the
    // next account (P1 fail-closed).
    if (credentials?.proxyExhausted) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} STRICT-PROXY-${credentials.reason === "error" ? "ERROR" : "EXHAUSTED"} (pool ${credentials.poolId || "?"}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = credentials.reason === "error"
        ? `Strict proxy pool ${credentials.poolId || ""} resolution failed`.trim()
        : `Strict proxy pool ${credentials.poolId || ""} exhausted`.trim();
      lastStatus = HTTP_STATUS.SERVICE_UNAVAILABLE;
      lastProxyExhausted = true;
      continue;
    }

    // Circuit breaker (phase 06): per-account gate BEFORE attempting. An
    // open breaker skips the candidate like any other unavailable account.
    // The exclusion-set add is load-bearing — a bare continue would re-pick
    // the same account forever. noauth free-provider credentials have no
    // connectionId and bypass the gate entirely.
    if (credentials.connectionId) {
      const gate = checkBreaker(credentials.connectionId, provider);
      if (!gate.allowed) {
        log.warn("BREAKER", `⏸ ACC:${credentials.connectionName} breaker-open (retry in ${Math.ceil(gate.retryAfterMs / 1000)}s) → NEXT ACCOUNT`);
        excludeConnectionIds.add(credentials.connectionId);
        breakerRetryAfterMs = Math.min(breakerRetryAfterMs, gate.retryAfterMs);
        lastError = lastError || "All remaining accounts circuit-broken";
        lastStatus = lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE;
        continue;
      }
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const result = await handleChatCore({
      body: { ...body, model: `${provider}/${model}` },
      modelInfo: { provider, model },
      credentials: refreshedCredentials,
      log,
      clientRawRequest,
      connectionId: credentials.connectionId,
      userAgent,
      apiKey,
      ccFilterNaming: !!chatSettings.ccFilterNaming,
      rtkEnabled: !!chatSettings.rtkEnabled,
      headroomEnabled: !!chatSettings.headroomEnabled,
      headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
      headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
      headroomTimeoutMs: chatSettings.headroomTimeoutMs,
      cavemanEnabled: !!chatSettings.cavemanEnabled,
      cavemanLevel: chatSettings.cavemanLevel || "full",
      ponytailEnabled: !!chatSettings.ponytailEnabled,
      ponytailLevel: chatSettings.ponytailLevel || "full",
      pxpipeEnabled: !!chatSettings.pxpipeEnabled,
      pxpipeMinChars: chatSettings.pxpipeMinChars,
      pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
      // Lazily warms the in-process module on first use; null when not installed (fail-open)
      pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
      onPxpipeEvent: appendPxpipeEvent,
      providerThinking,
      // Detect source format by endpoint + body
      sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
      onCredentialsRefreshed: async (newCreds) => {
        await updateProviderCredentials(credentials.connectionId, {
          ...newCreds,
          existingProviderSpecificData: credentials.providerSpecificData,
          testStatus: "active"
        });
      },
      onRequestSuccess: async () => {
        await clearAccountError(credentials.connectionId, credentials, model);
        // "Consecutive" strikes: a success clears the breaker for this pair.
        clearAntigravityStrikes(credentials.connectionId, model);
        // Circuit breaker (phase 06): a success at first forwarded byte (N7
        // signal) closes any open/half-open breaker for this account.
        recordSuccess(credentials.connectionId);
      }
    });

    if (result.success) return result.response;

    const psd = refreshedCredentials?.providerSpecificData || {};
    const usedPoolId = psd.connectionProxyPoolId || null;
    const usedEntryId = psd.connectionProxyEntryId || null;

    // --- Managed-pool connection-failure retry (rotation teardown window) ---
    // When a request through the managed pool fails with a CONNECTION-level
    // error (SOCKS port down during a switchConfig kill+respawn), the failure
    // is transient infra noise — NOT an account problem. Wait for any in-flight
    // rotation to settle, for the SOCKS port to come back, then retry the SAME
    // account without marking it unavailable. Bounded by MAX_MANAGED_CONN_RETRIES.
    if (
      usedPoolId === MANAGED_POOL_ID &&
      result.status === HTTP_STATUS.BAD_GATEWAY &&
      isConnectionFailure(result.error) &&
      managedConnRetries < MAX_MANAGED_CONN_RETRIES
    ) {
      managedConnRetries += 1;
      // Derive the SOCKS port this request actually used: parse it from the
      // resolved proxy URL (authoritative — a blue-green switch may have moved
      // the active instance off the configured settings port).
      const portMatch = /:\/\/127\.0\.0\.1:(\d+)/.exec(psd.connectionProxyUrl || "");
      const connSocksPort = Number(portMatch?.[1]) || Number(psd.connectionSocksPort) || Number((await getSettings().catch(() => ({})))?.xraySocksPort) || 10808;
      log.warn("PROXY", `Managed-pool connection failure (likely mid-rotation); waiting for SOCKS port ${connSocksPort} then retry ${managedConnRetries}/${MAX_MANAGED_CONN_RETRIES}`);
      // 1. Let any in-flight rotation finish (it may be the one that tore the port down).
      await waitForManagedRotationSettle({ maxWaitMs: 6000 });
      // 2. Wait for the port to accept connections again (≤6s).
      const up = await waitForSocksPortOpen(connSocksPort, 6000);
      managedConnPortOpen = up;
      if (up) {
        // Port is back — retry the same account + body. Do NOT mark the
        // account unavailable or exclude it; this was an infra blip.
        lastError = result.error;
        lastStatus = result.status;
        continue;
      }
      // Port didn't come back in time — fall through to normal error handling.
      log.warn("PROXY", `Managed-pool SOCKS port ${connSocksPort} did not come back within 6s; falling through to error handling`);
    }

    // --- Managed-pool flakiness tracking (status-agnostic) ---
    // Mid-stream aborts (`TypeError: terminated`) surface with NO http status
    // — the response already started (200) when the stream died — so they can
    // never satisfy the rotatable gate below, yet they are THE signature of a
    // flaky node. Count every managed-pool connection-level failure here,
    // status or not; three in a rolling 5-min window rotate the pool. (The
    // rotation module's adaptive cooldown bypass handles the case where the
    // flaky node was itself just rotated to.)
    if (usedPoolId === MANAGED_POOL_ID && isConnectionFailure(result.error)) {
      const { flaky, countInWindow } = noteManagedPoolConnFailure();
      if (flaky) {
        log.warn("PROXY", `Managed-pool ${countInWindow} connection-level failures in the last 5min (flaky node); rotating to a healthy one`);
        triggerManagedRotationOnProxyError({
          status: result.status,
          error: typeof result.error === "string" ? result.error : "",
          model: `${provider}/${model}`,
        }).catch(() => {});
      }
    }

    // Public/no-auth connections (free providers) have no account to protect:
    // there is nothing to "burn" by trying another IP, and edge/bot blocks can
    // masquerade as 401/402/403. So when the request went through a proxy
    // pool, rotate on ANY http error except the request-shape-deterministic
    // ones (400/404/405/413/422 fail identically on every IP). Authenticated
    // connections keep the conservative taxonomy in isProxyRotatableError —
    // for those, 401/402 really are credential/billing problems and rotating
    // would just re-fail on a fresh node.
    const isPublicConn = credentials?.id === "noauth" || credentials?.connectionName === "Public";
    const rotatable =
      isProxyRotatableError(result.status, result.error) ||
      (isPublicConn &&
        usedPoolId != null &&
        Number.isFinite(Number(result.status)) &&
        Number(result.status) >= 400 &&
        ![400, 404, 405, 413, 422].includes(Number(result.status)));

    // --- Proxy-group / managed-pool rotation on rotatable errors (429/rate-limit/5xx) ---
    // When a request fails through a proxy-group entry with an error that's
    // often IP-specific, cool down that entry and retry the SAME account with a
    // different proxy from the group — rather than burning the whole account.
    // Only fall back to the next account once the group has no entries left.
    //
    // Managed pool (v2go-xray-managed) is a single-URL pool backed by one
    // running xray instance. It has no per-entry rotation, so on a rotatable
    // error (e.g. 429 rate-limit on the current egress IP) kick off a
    // background switchConfig() to a different healthy outbound for this
    // model. Fire-and-forget: switchConfig is blue-green (new instance on a
    // fresh port, pool repointed after health verification), so in-flight
    // requests are unaffected — the next request resolves the pool and hits
    // the new IP.
    if (rotatable && usedPoolId === MANAGED_POOL_ID) {
      // Connection-level failures (SOCKS port down, terminated streams) are
      // usually infra noise — often self-inflicted by a rotation's teardown —
      // NOT an IP-rate-limit signal. Rotating on them amplifies the outage:
      // each switch tears down more streams, which fail as 502s, which trigger
      // yet another rotation. They are handled by the retry path above…
      if (isConnectionFailure(result.error)) {
        // …EXCEPT when the retries already ran and the SOCKS port kept
        // accepting connections the whole time (or never came back with no
        // rotation in flight to blame). Then the teardown-noise theory is
        // dead: the xray process is up but its outbound can't reach anything
        // (dead node). Flaky nodes are handled by the status-agnostic rolling
        // counter above — including the status-less mid-stream aborts that
        // never reach this gate. triggerManagedRotationOnProxyError has its
        // own in-flight + cooldown guards, so this is safe to call per request.
        if (managedConnRetries >= MAX_MANAGED_CONN_RETRIES || managedConnPortOpen === false) {
          const why = managedConnPortOpen === false
            ? "SOCKS port down without an in-flight rotation"
            : "SOCKS port up but outbound dead";
          log.warn("PROXY", `Managed-pool ${why}; triggering managed rotation to a healthy node`);
          triggerManagedRotationOnProxyError({
            status: result.status,
            error: typeof result.error === "string" ? result.error : "",
            model: `${provider}/${model}`,
          }).catch(() => {});
        } else {
          log.warn("PROXY", "Managed-pool connection failure classified as non-rotatable (infra noise, not IP-specific)");
        }
      } else {
        triggerManagedRotationOnProxyError({
          status: result.status,
          error: typeof result.error === "string" ? result.error : "",
          model: `${provider}/${model}`,
        }).catch(() => {});
      }
    }

    if (rotatable && usedPoolId && usedEntryId) {
      // Cool down the entry that just failed.
      const cdMs = proxyCooldownForError(result.status, result.error);
      await markProxyEntryCooldown(usedPoolId, usedEntryId, cdMs, result.error).catch(() => {});
      log.warn("PROXY", `Entry ${usedEntryId} in group ${usedPoolId} cooled down ${cdMs}ms (${result.status})`);

      // Track which entries we've already tried this request so re-resolve
      // skips them even before their cooldown timestamp lands in the DB.
      excludedProxyEntryIds.add(usedEntryId);

      // Is there still a usable entry in the group? If so, retry the SAME
      // account without excluding it — the next loop iteration will re-resolve
      // (getProviderCredentials picks a fresh entry) and we also override the
      // proxy fields directly to be safe for the no-auth path.
      const pool = await getProxyPoolById(usedPoolId).catch(() => null);
      if (pool && groupHasAvailableEntry(pool, excludedProxyEntryIds)) {
        lastError = result.error;
        lastStatus = result.status;
        // Don't exclude the connection — keep the account, switch the proxy.
        // Re-resolve will pick the next available entry from the group.
        continue;
      }
      // Group exhausted → account fallback. Under strictProxy the account
      // itself is fine (its pool is dead), so skip the model-lock entirely and
      // just exclude it for this request — pool cooldowns are pool state, not
      // account state (P1). TODO(phase-05): emit proxy-pool-exhausted here.
      if (psd.strictProxy === true) {
        log.warn("PROXY", `Group ${usedPoolId} exhausted (strict) — skipping account without lock → NEXT ACCOUNT`);
        excludeConnectionIds.add(credentials.connectionId);
        lastError = result.error;
        lastStatus = result.status;
        lastProxyExhausted = true;
        continue;
      }
      // Group exhausted → fall back to account fallback below.
      log.warn("PROXY", `Group ${usedPoolId} exhausted, falling back to next account`);
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    // Mark account unavailable (auto-calculates cooldown with exponential backoff, or precise resetsAtMs)
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${result.status}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      // Feed the per-account circuit breaker — EXCEPT antigravity quota-429s
      // already owned by the upstream strike-block, which excludes the pair
      // at selection time (R9: no double-blocking the same account).
      if (!(provider === "antigravity" && isStrikeBlocked(credentials.connectionId, model))) {
        recordFailure(credentials.connectionId, provider);
      }
      continue;
    }

    return result.response;
  }
}
