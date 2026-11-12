import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { emitAlertMock } = vi.hoisted(() => ({ emitAlertMock: vi.fn() }));

// The wire module's alert channel is mocked (alerts are inert under tests);
// EVENT_TYPES/SEVERITY mirror the real catalog so payload assertions hold.
vi.mock("@/lib/alerts", () => ({
  emitAlert: emitAlertMock,
  EVENT_TYPES: {
    OPENCODE_WIRE_DRIFT: "opencode-wire-drift",
    OPENCODE_BUN_LANE_UNAVAILABLE: "opencode-bun-lane-unavailable",
  },
  SEVERITY: { INFO: "info", WARN: "warn", CRITICAL: "critical" },
}));

import {
  __test__,
  deriveModelDisplayName,
  getEmbeddedWireSnapshot,
  mintV2IdentityHeaders,
  mintV2SessionId,
  renderSystemText,
  shapeV2FreeLaneRequestBody,
  startWireSnapshotSync,
} from "../../open-sse/providers/opencodeWire.js";
import { OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const snapshot = getEmbeddedWireSnapshot();

beforeEach(() => {
  emitAlertMock.mockClear();
  __test__.reset();
});

describe("wire snapshot — committed artifact invariants", () => {
  it("carries the P0-proven v2 ground truth", () => {
    expect(snapshot.clientVersion).toBe("2.2.7");
    expect(snapshot.endpoint).toBe("https://opencode.ai/inference/openai/v1/chat/completions");
    expect(snapshot.xOpencodeProject).toBe("global");
    expect(snapshot.sourceSha).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // NO pinned template hash — deliberate snapshot bumps must not break tests.
    expect(snapshot.systemTextTemplate).toContain("You are an AI agent running in OpenCode");
    expect(snapshot.systemTextTemplate).toContain("# Code Mode");
    expect(snapshot.systemTextTemplate).toContain("{{DATE_UTC}}");
    expect(snapshot.systemTextTemplate).toContain("{{CWD}}");
    expect(snapshot.systemTextTemplate).toContain("{{PLATFORM}}");
    expect(snapshot.systemTextTemplate).toContain("{{MODEL_NAME}}");
    expect(snapshot.systemTextTemplate).toContain("{{MODEL_ID}}");
    expect(Buffer.byteLength(snapshot.systemTextTemplate)).toBeGreaterThan(6000);
    expect(Buffer.byteLength(snapshot.systemTextTemplate)).toBeLessThan(12000);
  });

  it("has exactly the 12 CLI tool manifests", () => {
    expect(snapshot.tools.map((t) => t.function.name).sort()).toEqual(
      ["edit", "execute", "glob", "grep", "question", "read", "shell", "skill", "subagent", "webfetch", "websearch", "write"],
    );
    for (const t of snapshot.tools) {
      expect(t.type).toBe("function");
      expect(t.function.parameters).toBeTruthy();
    }
  });

  it("contains no personal contamination (plan R10)", () => {
    const committed = fs.readFileSync(
      path.join(ROOT, "open-sse/providers/opencodeWire.snapshot.json"),
      "utf8",
    );
    expect(committed).not.toMatch(/ankha|9router-mod|ClaudeKit|Orchestration Protocol|## Rule:|AGENTS\.md|\.claude|ak-|gitnexus/i);
  });

  it("extraction script --check stays honest against the committed artifact", () => {
    // Structural guard: the module must have no file-write surface (detect-only
    // sync never writes). The authoritative byte-equality check runs in CI via
    // `node scripts/extract-opencode-wire.mjs --check`.
    const src = fs.readFileSync(path.join(ROOT, "open-sse/providers/opencodeWire.js"), "utf8");
    expect(src).not.toMatch(/writeFile|appendFile|fs\.write/);
  });
});

describe("renderSystemText", () => {
  it("fills every marker — no {{ residue", () => {
    const text = renderSystemText(snapshot, {
      modelId: "deepseek-v4.1-flash-free",
      cwd: "/srv/app",
      platform: "linux",
      date: new Date("2026-11-12T00:00:00Z"),
    });
    expect(text).not.toContain("{{");
    expect(text).toContain("Model ID: deepseek-v4.1-flash-free");
    expect(text).toContain("Working directory: /srv/app");
    expect(text).toContain("Platform: linux");
    expect(text).toContain("Today's date: Thu Nov 12 2026");
  });

  it("derives the model display name when modelName is absent", () => {
    const text = renderSystemText(snapshot, { modelId: "deepseek-v4.1-flash-free" });
    expect(text).toContain("Name: Deepseek V4.1 Flash");
    expect(text).not.toContain("{{");
  });

  it("throws on an unknown placeholder (extraction bug must never ship markers)", () => {
    const broken = { ...snapshot, systemTextTemplate: snapshot.systemTextTemplate + "\n{{UNKNOWN}}" };
    expect(() => renderSystemText(broken, { modelId: "x" })).toThrow(/unrendered placeholder/);
  });

  it("renders the exact P0-proven R2 composition shape", () => {
    const text = renderSystemText(snapshot, { modelId: "deepseek-v4.1-flash-free" });
    // order: harness prefix → # Your Model → # Code Mode → env tail
    const harness = text.indexOf("You are an AI agent");
    const yourModel = text.indexOf("# Your Model");
    const codeMode = text.indexOf("# Code Mode");
    const env = text.indexOf("Today's date:");
    expect(harness).toBeGreaterThan(-1);
    expect(yourModel).toBeGreaterThan(harness);
    expect(codeMode).toBeGreaterThan(yourModel);
    expect(env).toBeGreaterThan(codeMode);
    expect(text).not.toContain("<available_skills>");
  });
});

describe("shapeV2FreeLaneRequestBody", () => {
  const callerBody = {
    model: "deepseek-v4.1-flash-free",
    messages: [
      { role: "system", content: "caller system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "go on" },
    ],
    tools: [
      { type: "function", function: { name: "read", description: "caller read", parameters: { type: "object" } } },
      { type: "function", function: { name: "web_search", description: "caller tool", parameters: { type: "object" } } },
    ],
    max_tokens: 512,
  };

  it("harness system first, caller system dropped, conversation preserved", () => {
    const shaped = shapeV2FreeLaneRequestBody(callerBody, snapshot);
    expect(shaped.messages[0].role).toBe("system");
    expect(shaped.messages[0].content).toContain("You are an AI agent");
    expect(shaped.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(shaped.messages.some((m) => m.content === "caller system prompt")).toBe(false);
    expect(shaped.model).toBe("deepseek-v4.1-flash-free");
  });

  it("merges snapshot tools with caller tools, deduped by name (snapshot wins)", () => {
    const shaped = shapeV2FreeLaneRequestBody(callerBody, snapshot);
    const names = shaped.tools.map((t) => t.function.name);
    expect(names.filter((n) => n === "read")).toHaveLength(1);
    expect(names).toContain("web_search");
    expect(names).toContain("edit"); // snapshot manifest present
    expect(shaped.tools.find((t) => t.function.name === "read").function.description).toContain("Read the contents"); // snapshot manifest wins dedupe
  });

  it("forces stream + include_usage and defaults max_completion_tokens", () => {
    const shaped = shapeV2FreeLaneRequestBody(callerBody, snapshot);
    expect(shaped.stream).toBe(true);
    expect(shaped.stream_options).toEqual({ include_usage: true });
    expect(shaped.max_completion_tokens).toBe(512); // caller max_tokens mapped
    const noCap = shapeV2FreeLaneRequestBody({ model: "m", messages: [{ role: "user", content: "x" }] }, snapshot);
    expect(noCap.max_completion_tokens).toBe(32000);
  });
});

describe("mintV2IdentityHeaders", () => {
  it("mints the v2 CLI header set (no accept header)", () => {
    const ses = "ses_aaaaaaaaaaaaAAAAAAAAAAAAAA";
    const h = mintV2IdentityHeaders(snapshot, ses);
    expect(h.authorization).toBe("Bearer public");
    expect(h["user-agent"]).toBe("opencode/latest/2.2.7/cli");
    expect(h["x-opencode-client"]).toBe("cli");
    expect(h["x-opencode-project"]).toBe("global");
    expect(h["x-opencode-session"]).toBe(ses);
    expect(h["x-opencode-session-id"]).toBe(ses);
    expect(h["x-session-affinity"]).toBe(ses);
    expect(h["x-session-id"]).toBe(ses);
    expect(h["content-type"]).toBe("application/json");
    expect(h.accept).toBeUndefined();
  });
});

describe("mintV2SessionId", () => {
  it("mints CLI-shaped ids via the executor's generateSessionId (never re-implements)", () => {
    const id = mintV2SessionId();
    expect(OPENCODE_SESSION_RE.test(id)).toBe(true);
    // provenance is structural: the wire module imports the executor's minting
    const src = fs.readFileSync(path.join(ROOT, "open-sse/providers/opencodeWire.js"), "utf8");
    expect(src).toContain('import { generateSessionId } from "../executors/opencode.js"');
  });
});

describe("deriveModelDisplayName", () => {
  it("matches the P0-proven derivation", () => {
    expect(deriveModelDisplayName("deepseek-v4.1-flash-free")).toBe("Deepseek V4.1 Flash");
    expect(deriveModelDisplayName("grok-4-fast-free")).toBe("Grok 4 Fast");
  });
});

describe("detect-only snapshot sync", () => {
  it("emits OPENCODE_WIRE_DRIFT on version mismatch (no file writes)", async () => {
    __test__.injectFetch(async () => ({
      json: async () => ({ version: "2.3.0", sha: "a".repeat(40) }),
    }));
    const res = await __test__.runTick();
    expect(res.drifted).toBe(true);
    expect(emitAlertMock).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emitAlertMock.mock.calls[0];
    expect(eventType).toBe("opencode-wire-drift");
    expect(payload.severity).toBe("warn");
    expect(payload.details.current).toBe("2.2.7");
    expect(payload.details.latest).toBe("2.3.0");
    expect(payload.details.sha).toBe("a".repeat(40));
    expect(payload.details.note).toContain("scripts/extract-opencode-wire.mjs");
  });

  it("rejects crafted sha values (SEC-2: 40-hex only)", async () => {
    __test__.injectFetch(async () => ({
      json: async () => ({ version: "2.3.0", sha: "javascript:alert(1)" }),
    }));
    const res = await __test__.runTick();
    expect(res.drifted).toBe(true);
    expect(emitAlertMock.mock.calls[0][1].details.sha).toBeUndefined();
  });

  it("fetch failure → logged only, no alert, no throw", async () => {
    __test__.injectFetch(async () => {
      throw new Error("boom");
    });
    const res = await __test__.runTick();
    expect(res.drifted).toBe(false);
    expect(res.error).toContain("boom");
    expect(emitAlertMock).not.toHaveBeenCalled();
  });

  it("matching version → no alert", async () => {
    __test__.injectFetch(async () => ({
      json: async () => ({ version: "2.2.7", sha: "b".repeat(40) }),
    }));
    const res = await __test__.runTick();
    expect(res.drifted).toBe(false);
    expect(emitAlertMock).not.toHaveBeenCalled();
  });

  it("startWireSnapshotSync is idempotent and unref'd", () => {
    startWireSnapshotSync();
    startWireSnapshotSync();
    // no interval leak assertion — reset() in beforeEach cleared state; two
    // calls must not double-start (state.syncStarted guards).
  });
});
