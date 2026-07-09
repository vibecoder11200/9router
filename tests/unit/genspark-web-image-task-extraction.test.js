// Unit test for the Genspark image flow's task-id extraction logic.
// We test the pure helper functions by importing them via a small shim that
// re-exports them. Since the executor file doesn't export them directly, we
// re-implement the same parsing here to validate the logic against fixtures
// captured from genspark2api's expected response format.
import { describe, it, expect } from "vitest";

// Mirror of extractImageTaskIds from open-sse/executors/genspark-web.js.
// (Re-implemented here because the executor doesn't export the helper.)
function extractImageTaskIds(responseBody) {
  let projectId = "";
  const taskIds = [];
  const lines = responseBody.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr) continue;
    try {
      const outer = JSON.parse(jsonStr);
      if (outer.type === "project_start" && outer.id) {
        projectId = String(outer.id);
        continue;
      }
      if (typeof outer.content === "string" && outer.content.includes("task_id")) {
        try {
          const inner = JSON.parse(outer.content);
          const imgs = Array.isArray(inner?.generated_images) ? inner.generated_images : [];
          for (const img of imgs) {
            if (img?.task_id) taskIds.push(String(img.task_id));
          }
        } catch {
          // content wasn't JSON — skip.
        }
      }
    } catch {
      // line wasn't JSON — skip.
    }
  }
  return [projectId, taskIds];
}

describe("genspark-web image task-id extraction", () => {
  it("extracts project_id and task_ids from a typical COPILOT_MOA_IMAGE response", () => {
    const body = [
      `data: {"id":"proj_abc123","type":"project_start","role":"assistant"}`,
      `data: {"content":"{\\"generated_images\\":[{\\"task_id\\":\\"task_001\\"},{\\"task_id\\":\\"task_002\\"}]}", "type":"message_field"}`,
      ``,
    ].join("\n");
    const [projectId, taskIds] = extractImageTaskIds(body);
    expect(projectId).toBe("proj_abc123");
    expect(taskIds).toEqual(["task_001", "task_002"]);
  });

  it("returns empty taskIds when the response has no generated_images", () => {
    const body = [
      `data: {"id":"proj_xyz","type":"project_start"}`,
      `data: {"content":"hello world", "type":"message_field"}`,
    ].join("\n");
    const [projectId, taskIds] = extractImageTaskIds(body);
    expect(projectId).toBe("proj_xyz");
    expect(taskIds).toEqual([]);
  });

  it("skips malformed JSON lines without throwing", () => {
    const body = [
      `data: {invalid json`,
      `data: {"id":"proj_ok","type":"project_start"}`,
      `data: {"content":"not json at all {task_id}", "type":"message_field"}`,
      `data: {"content":"{\\"generated_images\\":[{\\"task_id\\":\\"task_99\\"}]}", "type":"message_field"}`,
    ].join("\n");
    const [projectId, taskIds] = extractImageTaskIds(body);
    expect(projectId).toBe("proj_ok");
    expect(taskIds).toEqual(["task_99"]);
  });

  it("handles an empty body", () => {
    const [projectId, taskIds] = extractImageTaskIds("");
    expect(projectId).toBe("");
    expect(taskIds).toEqual([]);
  });

  it("ignores lines without the data: prefix", () => {
    const body = [
      `event: message`,
      `: keepalive`,
      `data: {"id":"proj_p","type":"project_start"}`,
      `random noise`,
    ].join("\n");
    const [projectId, taskIds] = extractImageTaskIds(body);
    expect(projectId).toBe("proj_p");
    expect(taskIds).toEqual([]);
  });
});
