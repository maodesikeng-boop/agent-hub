import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const HUB_LIMIT_SOURCES = [
  "src/hub/usage.ts",
  "src/hub/parse-core.ts",
  "src/hub/parse-worker.ts",
  "src/hub/parse-router.ts",
  "src/hub/parse-graph.ts",
  "src/daemon/agent-api/server.ts",
  "src/daemon/ledger/hub-commands.ts",
  "src/daemon/ledger/router.ts",
  "src/daemon/ledger/schedules.ts",
  "src/daemon/ledger/persona.ts",
  "src/daemon/ledger/projects.ts",
  "src/daemon/ledger/worker-search.ts",
  "src/daemon/ledger/workers/start.ts",
  "src/daemon/ledger/workers/text.ts",
  "src/daemon/ledger/task-graphs/spec.ts",
  "src/daemon/ledger/task-graphs/create.ts",
  "src/daemon/ledger/task-graphs/patch.ts",
  "src/daemon/ledger/task-graphs/gate.ts",
  "src/daemon/ledger/task-graphs/lifecycle.ts",
  "src/shared/domain.ts",
];

// A limit phrase interpolating a size constant directly; time limits (`*_MS`) are not hub input limits.
const HAND_WRITTEN_LIMIT = /(最多|不能超过|不超过|上限)\s*\$\{\s*(?![A-Z0-9_]*_MS\b)[A-Z][A-Z0-9_]*MAX[A-Z0-9_]*\s*(?:[/*]\s*[^}]*)?\}/gu;

describe("hub limit phrases come from the limit table", () => {
  it("has no hand-written limit phrase in hub validators or help", () => {
    const found: string[] = [];
    for (const rel of HUB_LIMIT_SOURCES) {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        for (const m of line.matchAll(HAND_WRITTEN_LIMIT)) found.push(`${rel}:${i + 1}: ${m[0]}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("has no literal handoff limit in the Task Graph manual", () => {
    const skill = readFileSync(join(ROOT, "src/shared/task-graph-skill.ts"), "utf8");
    expect(skill).not.toMatch(/12,000|4,000/u);
  });
});
