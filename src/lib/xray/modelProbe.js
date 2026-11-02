import { FREE_PROVIDERS } from "@/shared/constants/providers.js";

/**
 * True for no-auth free-lane providers (e.g. OpenCode Free, "Bearer public").
 * Every chat-shaped probe against them spends REAL free-tier quota, and all
 * probes share the process-wide stable session (noAuth virtual connection),
 * hopping it across every tested exit IP — the exact pattern the upstream
 * gate flags, which then 429s the user's own traffic (same policy as the
 * dashboard Test button, upstream PR #5193 / issue #5149). Filter probes
 * against such providers must judge nodes by tunnel connectivity instead of
 * a chat completion.
 */
export function isNoAuthFreeChatProvider(providerId) {
  return FREE_PROVIDERS?.[providerId]?.noAuth === true;
}

/**
 * Shared request payload for the Model Proxy Filter probes (spawn-mode
 * testSingleConfigWithModel and api-mode probeModelViaChatCore).
 *
 * `max_tokens` is deliberately omitted. Upstreams enforce different minimum
 * caps — e.g. opencode's muse-spark-1.2-contributor-free rejects anything
 * below 16 with HTTP 400, which made every xray config "fail" regardless of
 * proxy quality — and OpenAI reasoning models reject `max_tokens` outright in
 * favor of `max_completion_tokens`. With the field absent, each upstream
 * applies its own default, and target-format translators that require it
 * inject one during translation (openai→claude and openai→commandcode:
 * adjustMaxTokens/DEFAULT_MAX_TOKENS; openai→gemini simply omits the optional
 * maxOutputTokens). The probe's pass/fail signal is
 * HTTP 2xx, so the uncapped reply length only affects latency, which is
 * bounded by the job's timeoutMs.
 */
export function buildModelProbeBody(modelInfo) {
  return {
    model: `${modelInfo.provider}/${modelInfo.model}`,
    stream: false,
    messages: [{ role: "user", content: "hi" }],
  };
}

/**
 * Bound a model probe by timeoutMs. On timeout the rejection propagates to
 * the filter's per-config catch (config marked failed with "Probe timed
 * out ..."), freeing the worker instead of letting a slow-generating model
 * hold it indefinitely. The abandoned upstream request dies with the
 * caller's teardown: spawn mode kills its temp xray in `finally`; api-mode
 * swaps or removes the worker's outbound on the next probe / at job stop.
 * A late rejection of the losing promise is swallowed so it can never
 * surface as an unhandled rejection after the race settles.
 */
export function withProbeTimeout(probePromise, timeoutMs, label = "") {
  if (!(Number(timeoutMs) > 0)) return probePromise;
  probePromise.catch(() => {});
  let timer = null;
  return Promise.race([
    probePromise,
    new Promise((_, reject) => {
      const err = new Error(`Probe timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`);
      err.name = "TimeoutError";
      timer = setTimeout(() => reject(err), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}
