// Upstream v0.5.109 browser-pool variant of gemini.google.com, re-id'd from
// upstream's "gemini-web" to "gemini-web-ui": the fork's own RPC-driven
// gemini-web (p131) already owns the "gemini-web" id and the "gweb" alias.
export default {
  id: "gemini-web-ui",
  priority: 220,
  alias: "gemini-web-ui",
  aliases: [
    "gweb2",
  ],
  uiAlias: "gemini-web-ui",
  display: {
    name: "Gemini Web (Browser)",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GW",
    website: "https://gemini.google.com",
  },
  category: "webCookie",
  authType: "cookie",
  // No "llm": chat models stay API-reachable but are hidden from LLM lists —
  // this provider is surfaced through the image media pages only.
  serviceKinds: ["image"],
  authHint: "Paste your __Secure-1PSID (and __Secure-1PSIDTS) cookie value(s) from gemini.google.com",
  transport: {
    baseUrl: "https://gemini.google.com/app",
    format: "openai",
    authType: "cookie",
  },
  // `supportsReasoning` is omitted deliberately: the executor drives the
  // gemini.google.com web UI by typing a prompt, so it has no thinking-budget
  // control to set and never surfaces `reasoning_content`. Tool calling is
  // prompt-emulated only (translator/webTools.js), never native.
  models: [
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash-Lite" },
    { id: "gemini-image", name: "Gemini Image (web)", params: ["n", "size"], kind: "image" },
  ],
};
