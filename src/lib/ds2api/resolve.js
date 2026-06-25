// Keep the ds2api provider routing in sync with the dashboard-configured service URL.
//
// The registry ships a static localhost:5001 baseUrl, but the sidecar may run on a
// different port (or the user may point at another loopback instance). The dashboard
// persists that URL in the `ds2apiUrl` setting; applyDs2apiUrl() patches PROVIDERS.ds2api
// at runtime so inference / test-connection / model-fetch requests reach the real URL.
import { PROVIDERS } from "open-sse/config/providers.js";

function normalizeBase(url) {
  const base = String(url || "").trim().replace(/\/$/, "");
  if (!base) return null;
  try {
    // Validate; throw away the parsed object (we only need the normalized string).
    new URL(base);
  } catch {
    return null;
  }
  return base;
}

export function ds2apiChatUrl(url) {
  const base = normalizeBase(url);
  return base ? `${base}/v1/chat/completions` : null;
}

// Patch the runtime transport for the ds2api provider. Returns true if applied.
export function applyDs2apiUrl(url) {
  const base = normalizeBase(url);
  const entry = PROVIDERS.ds2api;
  if (!base || !entry) return false;
  entry.baseUrl = `${base}/v1/chat/completions`;
  entry.validateUrl = `${base}/v1/models`;
  if (entry.modelsFetcher) entry.modelsFetcher.url = `${base}/v1/models`;
  return true;
}
