export default {
  id: "ds2api",
  priority: 40,
  alias: "ds2api",
  uiAlias: "DS2",
  // AI_PROVIDERS uses uiAlias ("DS2") as the storage/model-prefix alias, but the
  // open-sse resolver only maps `alias`/`aliases`. Include "DS2" so "DS2/<model>"
  // (used by the model test / disabled-models keys) resolves back to ds2api.
  aliases: ["DS2"],
  display: {
    name: "DeepSeek Web",
    icon: "cloud",
    color: "#10B981",
    textIcon: "DW",
    website: "https://github.com/CJackHwang/ds2api",
    notice: {
      signupUrl: "https://github.com/CJackHwang/ds2api/releases",
    },
  },
  category: "apikey",
  authType: "apikey",
  serviceKinds: ["llm", "embedding"],
  transport: {
    // Default loopback URL; patched at runtime from the ds2apiUrl setting
    // (see src/lib/ds2api/resolve.js → applyDs2apiUrl).
    baseUrl: "http://localhost:5001/v1/chat/completions",
    format: "openai",
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
    validateUrl: "http://localhost:5001/v1/models",
    modelsFetcher: { url: "http://localhost:5001/v1/models", type: "openai" },
  },
  passthroughModels: true,
  // Native DeepSeek model ids exposed by the sidecar (GET /v1/models). Declared
  // statically so they populate the model picker / combos / Available Models even
  // before the sidecar is running; passthroughModels still lets clients send aliases.
  models: [
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-flash-nothinking", name: "DeepSeek V4 Flash (no thinking)" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-pro-nothinking", name: "DeepSeek V4 Pro (no thinking)" },
    { id: "deepseek-v4-flash-search", name: "DeepSeek V4 Flash Search" },
    { id: "deepseek-v4-flash-search-nothinking", name: "DeepSeek V4 Flash Search (no thinking)" },
    { id: "deepseek-v4-pro-search", name: "DeepSeek V4 Pro Search" },
    { id: "deepseek-v4-pro-search-nothinking", name: "DeepSeek V4 Pro Search (no thinking)" },
    { id: "deepseek-v4-vision", name: "DeepSeek V4 Vision" },
    { id: "deepseek-v4-vision-nothinking", name: "DeepSeek V4 Vision (no thinking)" },
  ],
  features: {
    usage: true,
  },
};
