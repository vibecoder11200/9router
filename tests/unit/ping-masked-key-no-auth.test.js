// Regression: v0.6.36 (S7, keys hashed at rest) turned apiKeys.key into the
// MASKED display string (sk-{keyId}-••••{last4}). The model-test ping used to
// put that value into `Authorization: Bearer …`, and fetch threw
// "Cannot convert argument to a ByteString because the character at index 17
// has a value of 8226…" (U+2022 '•') on every model test. The masked key must
// never be sent — with requireApiKey=off no auth is needed at all.
import { describe, it, expect, beforeEach, vi } from "vitest";
import http from "node:http";

const mocks = vi.hoisted(() => ({
  getApiKeys: vi.fn(),
  getConsistentMachineId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getApiKeys: mocks.getApiKeys,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

// 13-char keyId ⇒ the first • lands exactly at index 17 (the crash in the bug report).
const MASKED_KEY = "sk-abc12345defgh-••••9f4a";

describe("model test ping with a masked API key row (S7 regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getApiKeys.mockResolvedValue([{ key: MASKED_KEY, isActive: true }]);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
  });

  it("does not send the masked key as Authorization (no ByteString crash)", async () => {
    let seenAuth = "<never reached server>";
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization ?? null;
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
      const result = await pingModelByKind("oc/mimo-v2.5-free", "llm", `http://127.0.0.1:${port}`);

      // Pre-fix this call never reached the server: fetch() threw the
      // ByteString TypeError on the • characters before connecting.
      expect(seenAuth).toBeNull();
      expect(result.ok).toBe(true);
      expect(String(result.error || "")).not.toContain("ByteString");
    } finally {
      server.close();
    }
  });
});
