/**
 * Gemini Web Model Definitions
 *
 * Model IDs and headers for Gemini Web (gemini.google.com).
 * These correspond to the Model enum in the Python gemini_webapi library.
 *
 * Model header format:
 *   x-goog-ext-525001261-jspb: [1,null,null,null,"<model_id>",null,null,null,[<capacity>]]
 *
 * Capacity:
 *   1 = Basic (free tier)
 *   2 = Advanced
 *   4 = Plus
 */

function buildModelHeader(modelId, capacity) {
  return {
    "x-goog-ext-525001261-jspb": JSON.stringify([1, null, null, null, modelId, null, null, null, [capacity]]),
    "x-goog-ext-73010989-jspb": "[0]",
    "x-goog-ext-73010990-jspb": "[0]",
  };
}

export const GEMINI_WEB_MODELS = {
  // Basic (free) tier models
  "gemini-3-pro": {
    modelName: "gemini-3-pro",
    header: buildModelHeader("9d8ca3786ebdfbea", 1),
    advancedOnly: false,
  },
  "gemini-3-flash": {
    modelName: "gemini-3-flash",
    header: buildModelHeader("fbb127bbb056c959", 1),
    advancedOnly: false,
  },
  "gemini-3-flash-thinking": {
    modelName: "gemini-3-flash-thinking",
    header: buildModelHeader("5bf011840784117a", 1),
    advancedOnly: false,
  },

  // Plus tier models
  "gemini-3-pro-plus": {
    modelName: "gemini-3-pro-plus",
    header: buildModelHeader("e6fa609c3fa255c0", 4),
    advancedOnly: true,
  },
  "gemini-3-flash-plus": {
    modelName: "gemini-3-flash-plus",
    header: buildModelHeader("56fdd199312815e2", 4),
    advancedOnly: true,
  },
  "gemini-3-flash-thinking-plus": {
    modelName: "gemini-3-flash-thinking-plus",
    header: buildModelHeader("e051ce1aa80aa576", 4),
    advancedOnly: true,
  },

  // Advanced tier models
  "gemini-3-pro-advanced": {
    modelName: "gemini-3-pro-advanced",
    header: buildModelHeader("e6fa609c3fa255c0", 2),
    advancedOnly: true,
  },
  "gemini-3-flash-advanced": {
    modelName: "gemini-3-flash-advanced",
    header: buildModelHeader("56fdd199312815e2", 2),
    advancedOnly: true,
  },
  "gemini-3-flash-thinking-advanced": {
    modelName: "gemini-3-flash-thinking-advanced",
    header: buildModelHeader("e051ce1aa80aa576", 2),
    advancedOnly: true,
  },

  // Image Generation models (use same model headers — image gen is prompt-driven)
  "gemini-3-flash-image": {
    modelName: "gemini-3-flash-image",
    header: buildModelHeader("fbb127bbb056c959", 1),
    advancedOnly: false,
    imageGeneration: true,
  },
  "gemini-3-pro-image": {
    modelName: "gemini-3-pro-image",
    header: buildModelHeader("9d8ca3786ebdfbea", 1),
    advancedOnly: false,
    imageGeneration: true,
  },
  "gemini-3-flash-image-plus": {
    modelName: "gemini-3-flash-image-plus",
    header: buildModelHeader("56fdd199312815e2", 4),
    advancedOnly: true,
    imageGeneration: true,
  },
  "gemini-3-pro-image-plus": {
    modelName: "gemini-3-pro-image-plus",
    header: buildModelHeader("e6fa609c3fa255c0", 4),
    advancedOnly: true,
    imageGeneration: true,
  },
  "gemini-3-flash-image-advanced": {
    modelName: "gemini-3-flash-image-advanced",
    header: buildModelHeader("56fdd199312815e2", 2),
    advancedOnly: true,
    imageGeneration: true,
  },
  "gemini-3-pro-image-advanced": {
    modelName: "gemini-3-pro-image-advanced",
    header: buildModelHeader("e6fa609c3fa255c0", 2),
    advancedOnly: true,
    imageGeneration: true,
  },

  // Video Generation models (Veo — same chat endpoint, prompt-driven)
  "gemini-3-veo-video": {
    modelName: "gemini-3-veo-video",
    header: buildModelHeader("fbb127bbb056c959", 1),
    advancedOnly: false,
    videoGeneration: true,
  },
  "gemini-3-veo-video-plus": {
    modelName: "gemini-3-veo-video-plus",
    header: buildModelHeader("56fdd199312815e2", 4),
    advancedOnly: true,
    videoGeneration: true,
  },
  "gemini-3-veo-video-advanced": {
    modelName: "gemini-3-veo-video-advanced",
    header: buildModelHeader("56fdd199312815e2", 2),
    advancedOnly: true,
    videoGeneration: true,
  },

  // Audio/Music Generation models
  "gemini-3-audio": {
    modelName: "gemini-3-audio",
    header: buildModelHeader("fbb127bbb056c959", 1),
    advancedOnly: false,
    audioGeneration: true,
  },
  "gemini-3-audio-plus": {
    modelName: "gemini-3-audio-plus",
    header: buildModelHeader("56fdd199312815e2", 4),
    advancedOnly: true,
    audioGeneration: true,
  },
  "gemini-3-audio-advanced": {
    modelName: "gemini-3-audio-advanced",
    header: buildModelHeader("56fdd199312815e2", 2),
    advancedOnly: true,
    audioGeneration: true,
  },
};

export const DEFAULT_GEMINI_WEB_MODEL = "gemini-3-flash";

/**
 * Resolve model config by name. Falls back to default if not found.
 */
export function resolveGeminiWebModel(modelName) {
  if (!modelName) return GEMINI_WEB_MODELS[DEFAULT_GEMINI_WEB_MODEL];
  const model = GEMINI_WEB_MODELS[modelName];
  if (model) return model;
  // Try partial match
  for (const [key, val] of Object.entries(GEMINI_WEB_MODELS)) {
    if (key.includes(modelName) || modelName.includes(key)) return val;
  }
  return GEMINI_WEB_MODELS[DEFAULT_GEMINI_WEB_MODEL];
}

/**
 * Get model header for a given model name.
 */
export function getModelHeader(modelName) {
  const model = resolveGeminiWebModel(modelName);
  return model.header;
}
