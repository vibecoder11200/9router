export default {
  id: "ds2api",
  priority: 40,
  alias: "ds2api",
  uiAlias: "DS2",
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
  features: {
    usage: true,
  },
};
