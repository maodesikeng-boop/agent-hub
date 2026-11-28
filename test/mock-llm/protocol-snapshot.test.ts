import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEvent } from "../../src/shared/index.ts";
import { MOCK_LLM_SNAPSHOT_MAX_BYTES } from "./limits.ts";
import {
  diffJsonSchemaTrees,
  evaluateJsonSchemaDrift,
  normalizeDriverEvents,
  normalizeModelContext,
  normalizeVolatileText,
} from "./protocol-snapshot.ts";
import type { RecordedLlmRequest } from "./types.ts";

describe("protocol normalization and schema drift detection", () => {
  it("normalizes volatile UUIDs, loopback ports, ISO timestamps, and custom temp paths deterministically", () => {
    const raw =
      "Session 79f5269c-2a98-412d-a54c-eb0a359fd0ef at 2026-11-28T02:33:55.123Z calling http://127.0.0.1:59113/v1 in /tmp/bw-run-abc/work";
    const normalized = normalizeVolatileText(raw, { "/tmp/bw-run-abc": "<TEMP_ROOT>" });
    expect(normalized).not.toContain("79f5269c-2a98-412d-a54c-eb0a359fd0ef");
    expect(normalized).not.toContain("59113");
    expect(normalized).not.toContain("2026-11-28T02:33:55.123Z");
    expect(normalized).toContain("<TEMP_ROOT>/work");
  });

  it("normalizes outbound model-visible context across dialects and bounds output size", () => {
    expect(MOCK_LLM_SNAPSHOT_MAX_BYTES).toBeGreaterThanOrEqual(64 * 1024);

    const reqA: RecordedLlmRequest = {
      seq: 1,
      receivedAt: 1000,
      method: "POST",
      path: "/v1/messages",
      dialect: "anthropic-messages",
      headers: {},
      body: {
        model: "claude-sonnet-5-5",
        system: [{ type: "text", text: "Root is /tmp/run-1/work id 11111111-2222-4333-8444-555555555555" }],
        tools: [{ name: "Write" }, { name: "Bash" }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
      rawBytes: 120,
      truncated: false,
    };
    const reqB: RecordedLlmRequest = {
      ...reqA,
      body: {
        model: "claude-sonnet-5-5",
        system: [{ type: "text", text: "Root is /tmp/run-2/work id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }],
        tools: [{ name: "Bash" }, { name: "Write" }],
        messages: [{ role: "user", content: "hello" }],
      },
    };

    const normA = normalizeModelContext(reqA, { replacements: { "/tmp/run-1": "<ROOT>" } });
    const normB = normalizeModelContext(reqB, { replacements: { "/tmp/run-2": "<ROOT>" } });
    expect(normA).toEqual(normB);
    expect(normA.toolNames).toEqual(["Bash", "Write"]);

    const dirtyReq: RecordedLlmRequest = { ...reqA, body: null };
    const dirtyNorm = normalizeModelContext(dirtyReq);
    expect(dirtyNorm.messages).toEqual([]);
  });

  it("normalizes Bellwood DriverEvent streams so two runs produce identical protocol snapshots", () => {
    const eventsRun1: DriverEvent[] = [
      { type: "session.started", resumed: false, model: "claude-sonnet-5-5", tools: ["Bash"], at: 1700000001000 },
      { type: "agent.text", uuid: "11111111-2222-4333-8444-555555555555", text: "Reply in /tmp/run-1", at: 1700000002000 },
      { type: "turn.ended", ok: true, interrupted: false, messageIds: [1], durationMs: 42, at: 1700000003000 },
    ];
    const eventsRun2: DriverEvent[] = [
      { type: "session.started", resumed: false, model: "claude-sonnet-5-5", tools: ["Bash"], at: 1700000099000 },
      { type: "agent.text", uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", text: "Reply in /tmp/run-2", at: 1700000099500 },
      { type: "turn.ended", ok: true, interrupted: false, messageIds: [9], durationMs: 88, at: 1700000099900 },
    ];

    const snap1 = normalizeDriverEvents(eventsRun1, { replacements: { "/tmp/run-1": "<ROOT>" } });
    const snap2 = normalizeDriverEvents(eventsRun2, { replacements: { "/tmp/run-2": "<ROOT>" } });
    expect(snap1).toEqual(snap2);
    expect(snap1.map((e) => e.type)).toEqual(["session.started", "agent.text", "turn.ended"]);
  });

  it("diffs two JSON Schema directories to detect added, removed, and changed protocol schemas", () => {
    const root = mkdtempSync(join(tmpdir(), "bw-schema-diff-"));
    try {
      const baseDir = join(root, "base");
      const currDir = join(root, "curr");
      mkdirSync(baseDir, { recursive: true });
      mkdirSync(currDir, { recursive: true });

      writeFileSync(join(baseDir, "ServerNotification.json"), JSON.stringify({ type: "object", properties: { a: { type: "string" } } }));
      writeFileSync(join(baseDir, "RemovedType.json"), JSON.stringify({ type: "string" }));
      writeFileSync(join(baseDir, "Unchanged.json"), JSON.stringify({ type: "number" }));

      writeFileSync(join(currDir, "ServerNotification.json"), JSON.stringify({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } } }));
      writeFileSync(join(currDir, "AddedType.json"), JSON.stringify({ type: "boolean" }));
      writeFileSync(join(currDir, "Unchanged.json"), JSON.stringify({ type: "number" }));

      const diff = diffJsonSchemaTrees(baseDir, currDir);
      expect(diff).toEqual({
        added: ["AddedType.json"],
        removed: ["RemovedType.json"],
        changed: ["ServerNotification.json"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evaluates breaking JSON Schema drift with non-zero exitCode when schemas are removed or changed", () => {
    expect(evaluateJsonSchemaDrift({ added: [], removed: [], changed: [] })).toMatchObject({
      breaking: false,
      exitCode: 0,
    });
    expect(evaluateJsonSchemaDrift({ added: ["NewEvent.json"], removed: [], changed: [] })).toMatchObject({
      breaking: false,
      exitCode: 0,
    });
    expect(evaluateJsonSchemaDrift({ added: [], removed: ["OldEvent.json"], changed: [] })).toMatchObject({
      breaking: true,
      exitCode: 1,
    });
    expect(evaluateJsonSchemaDrift({ added: ["NewEvent.json"], removed: [], changed: ["ServerNotification.json"] })).toMatchObject({
      breaking: true,
      exitCode: 1,
    });
  });
});
