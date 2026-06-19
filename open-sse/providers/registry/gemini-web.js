export default {
  id: "gemini-web",
  category: "webCookie",
  uiAlias: "gweb",
  display: {
    name: "Gemini Web",
    icon: "/images/providers/gemini-web.png",
    color: "#4285F4",
    textIcon: "GW",
    website: "https://gemini.google.com",
    authType: "cookie",
    authHint: "Paste your Gemini cookies (JSON from cookie editor)",
  },
  transport: {
    baseUrl: "https://gemini.google.com",
    format: "gemini-web",
    authType: "cookie",
  },
  serviceKinds: ["llm", "image", "video", "music"],
  imageConfig: {
    baseUrl: "https://gemini.google.com",
    authType: "cookie",
    authHeader: "cookie",
    outputFormat: "gemini-web-image"
  },
  models: [
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3-flash-thinking", name: "Gemini 3 Flash Thinking" },
    { id: "gemini-3-flash-image", name: "Gemini 3 Flash Image", kind: "image" },
    { id: "gemini-3-veo-video", name: "Gemini 3 Veo Video", kind: "video" },
    { id: "gemini-3-audio", name: "Gemini 3 Audio", kind: "music" },
  ]
};