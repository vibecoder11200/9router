export default {
  id: "gemini-web",
  category: "webCookie",
  uiAlias: "gweb",
  alias: "gweb",
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
  passthroughModels: true,
  models: [
    // LLM Models
    { id: "gemini-3-pro", name: "Gemini 3 Pro" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3-flash-thinking", name: "Gemini 3 Flash Thinking" },
    { id: "gemini-3-pro-plus", name: "Gemini 3 Pro+ (Plus)" },
    { id: "gemini-3-flash-plus", name: "Gemini 3 Flash+ (Plus)" },
    { id: "gemini-3-flash-thinking-plus", name: "Gemini 3 Flash Thinking+ (Plus)" },
    { id: "gemini-3-pro-advanced", name: "Gemini 3 Pro (Advanced)" },
    { id: "gemini-3-flash-advanced", name: "Gemini 3 Flash (Advanced)" },
    { id: "gemini-3-flash-thinking-advanced", name: "Gemini 3 Flash Thinking (Advanced)" },
    // Image Generation Models
    { id: "gemini-3-flash-image", name: "Gemini 3 Flash Image", kind: "image" },
    { id: "gemini-3-pro-image", name: "Gemini 3 Pro Image", kind: "image" },
    { id: "gemini-3-flash-image-plus", name: "Gemini 3 Flash Image+ (Plus)", kind: "image" },
    { id: "gemini-3-pro-image-plus", name: "Gemini 3 Pro Image+ (Plus)", kind: "image" },
    { id: "gemini-3-flash-image-advanced", name: "Gemini 3 Flash Image (Advanced)", kind: "image" },
    { id: "gemini-3-pro-image-advanced", name: "Gemini 3 Pro Image (Advanced)", kind: "image" },
    // Video Generation Models
    { id: "gemini-3-veo-video", name: "Gemini 3 Veo Video", kind: "video" },
    { id: "gemini-3-veo-video-plus", name: "Gemini 3 Veo Video+ (Plus)", kind: "video" },
    { id: "gemini-3-veo-video-advanced", name: "Gemini 3 Veo Video (Advanced)", kind: "video" },
    // Audio/Music Generation Models
    { id: "gemini-3-audio", name: "Gemini 3 Audio", kind: "music" },
    { id: "gemini-3-audio-plus", name: "Gemini 3 Audio+ (Plus)", kind: "music" },
    { id: "gemini-3-audio-advanced", name: "Gemini 3 Audio (Advanced)", kind: "music" },
  ]
};
