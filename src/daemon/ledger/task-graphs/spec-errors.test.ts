import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { LedgerRequestError } from "../../../shared/ledger.ts";
import { createLedger, type SqliteLedger } from "../index.ts";
import { createResolveFolder } from "../files.ts";
import { openTestDb } from "../../store/test-helpers.ts";
import type { Db } from "../../store/index.ts";
import { formatGraphSpecIssues } from "./spec-errors.ts";

let db: Db;
let root: string;
let ledger: SqliteLedger;
let sessionId: number;

beforeEach(() => {
  db = openTestDb();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "hub-spec-errors-")));
  const dataHome = join(root, ".agent-hub");
  const folder = join(root, "proj");
  mkdirSync(folder, { recursive: true });
  ledger = createLedger(db, {
    now: () => 10_000,
    pmHomeRoot: join(dataHome, "pm-home"),
    dataHome,
    resolveFolder: createResolveFolder({ dataHome, userHome: root }),
  });
  const created = ledger.createPm({ name: "PM", mode: "manage_only", persona: "", folder });
  sessionId = created.sessionId;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function callError(fn: () => unknown): LedgerRequestError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(LedgerRequestError);
    return error as LedgerRequestError;
  }
  throw new Error("Expected LedgerRequestError");
}

describe("S3: strict JSON validation and path-level error reporting for graph create and patch", () => {
  it("formats unrecognized keys with path and closest valid key suggestion, and wrong types with path", () => {
    const strictSchema = z.strictObject({
      steps: z.array(z.strictObject({ key: z.string(), title: z.string(), noOuterSandbox: z.boolean().optional() })),
    });
    const unknownRes = strictSchema.safeParse({ steps: [{ key: "impl", title: "Do it", no_outer_sandbox: true }] });
    expect(unknownRes.success).toBe(false);
    if (!unknownRes.success) {
      const msg = formatGraphSpecIssues("create", unknownRes.error.issues);
      expect(msg).toContain("steps[0]");
      expect(msg).toContain("no_outer_sandbox");
      expect(msg).toContain("noOuterSandbox");
    }

    const typeRes = strictSchema.safeParse({ steps: [{ key: "impl", title: 123 }] });
    expect(typeRes.success).toBe(false);
    if (!typeRes.success) {
      const msg = formatGraphSpecIssues("patch", typeRes.error.issues);
      expect(msg).toContain("steps[0].title");
      expect(msg).toContain("没有生效");
    }
  });

  it("rejects unknown step keys in graph create with closest-key suggestion, then succeeds on the next turn", () => {
    const err = callError(() =>
      ledger.hubCall(sessionId, "graph.create", {
        specJson: JSON.stringify({
          title: "Test graph",
          steps: [{ key: "impl", title: "Implement", no_outer_sandbox: true }],
        }),
      }),
    );
    expect(err.code).toBe("invalid");
    expect(err.message).toContain("no_outer_sandbox");
    expect(err.message).toContain("noOuterSandbox");
    expect(ledger.hubCall(sessionId, "graph.list", {}).data.graphs).toEqual([]);

    const ok = ledger.hubCall(sessionId, "graph.create", {
      specJson: JSON.stringify({
        title: "Test graph",
        steps: [{ key: "impl", title: "Implement" }],
      }),
    });
    expect(ok.data.graph.nodes.map((n) => n.key)).toEqual(["impl"]);
  });

  it("reports exact JSON path when graph create or patch has a wrong field type", () => {
    const createErr = callError(() =>
      ledger.hubCall(sessionId, "graph.create", {
        specJson: JSON.stringify({
          title: "Bad type",
          steps: [{ key: "impl", title: "Implement", readonly: "yes" }],
        }),
      }),
    );
    expect(createErr.code).toBe("invalid");
    expect(createErr.message).toContain("steps[0].readonly");

    const graph = ledger.hubCall(sessionId, "graph.create", {
      specJson: JSON.stringify({ title: "Patch target", steps: [{ key: "a", title: "Step A" }] }),
    }).data.graph;

    const patchErr = callError(() =>
      ledger.hubCall(sessionId, "graph.patch", {
        graphId: graph.id,
        specJson: JSON.stringify({
          addSteps: [{ key: "b", title: "Step B", dependencies: ["a"] }],
        }),
      }),
    );
    expect(patchErr.code).toBe("invalid");
    expect(patchErr.message).toContain("dependencies");
    expect(patchErr.message).toContain("deps");
  });

  it("regression: malformed JSON still fails with an invalid error and creates nothing", () => {
    const err = callError(() =>
      ledger.hubCall(sessionId, "graph.create", { specJson: "{not-json" }),
    );
    expect(err.code).toBe("invalid");
    expect(err.message).toContain("JSON");
    expect(ledger.hubCall(sessionId, "graph.list", {}).data.graphs).toEqual([]);
  });
});
