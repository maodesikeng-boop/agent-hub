import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { API_PATHS, ENV_HOME } from "../../../src/shared/index.ts";
import { fakeBench } from "../fake-bench.ts";
import { lifecycleRunners } from "./lifecycle.ts";

const { boot } = vi.hoisted(() => ({ boot: vi.fn() }));
vi.mock("node:child_process", { spy: true });
vi.mock("../local-instance.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../local-instance.ts")>(),
  spawnDaemon: boot,
  stopDaemon: async () => {},
}));

it("seeds upgrade data on the release before the candidate opens it", async () => {
  const root = mkdtempSync(join(tmpdir(), "tester-upgrade-"));
  const codeDir = join(root, "candidate");
  const release = join(root, "local", "release", "v1.2.3");
  const state = { conversations: [{ conversation: { id: 1 }, messages: [{ id: 4 }, { id: 5 }] }] };
  const { spawnSync } = await import("node:child_process");
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: "v1.2.3", stderr: "", pid: 0, output: [], signal: null });
  try {
    for (const dir of [release, codeDir]) {
      mkdirSync(join(dir, "node_modules"), { recursive: true });
      mkdirSync(join(dir, "migrations"), { recursive: true });
      writeFileSync(join(dir, "package.json"), "{}");
    }
    writeFileSync(join(codeDir, "migrations", "002.sql"), "");
    const dataDir = join(root, "resident");
    mkdirSync(join(dataDir, "state"), { recursive: true });
    writeFileSync(join(dataDir, "state", "hub.sqlite"), "candidate schema");
    const { bench } = fakeBench({
      version: 1, root, sandboxProject: root, testAccount: { githubLogin: "bench-bot" },
      guards: { dataDirs: [], uiPorts: [], meshPorts: [], feishuAppIds: [], githubLogins: [] },
      instances: [{ name: "mac", role: "local", dataDir, userHome: join(root, "user"), uiPort: 4417, meshPort: 4421, env: {} }],
    });
    const local = bench.local();
    Object.defineProperty(local, "codeDir", { value: codeDir });
    let seedSent = false;
    boot.mockImplementation(async (dir: string, env: Record<string, string>) => {
      const stateDir = join(env[ENV_HOME]!, "state");
      const database = join(stateDir, "hub.sqlite");
      if (dir === release) {
        expect(existsSync(database)).toBe(false);
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(database, "release schema");
      } else {
        expect(seedSent).toBe(true);
        expect(existsSync(database)).toBe(true);
        writeFileSync(join(stateDir, "hub.sqlite.bak-release"), "");
      }
      return {
        api: {
          json: async (method: string, path: string) => {
            if (path === API_PATHS.pms) return { pmId: 1, conversationId: 1 };
            if (method === "POST") { seedSent = true; return { messageId: 4 }; }
            if (path.startsWith(API_PATHS.messages(1))) return { messages: [{ id: 4, sender: "user", status: "replied" }, { id: 5, sender: "agent", kind: "text", text: "reply" }] };
            return seedSent ? state : { pms: [], conversations: [] };
          },
        },
      };
    });
    const result = await lifecycleRunners["lifecycle.upgrade-from-release"]!({ bench, feishu: null, evidenceDir: root, instance: "local", signal: new AbortController().signal, log: () => {} });
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ check: "data-opens", ok: true }), expect.objectContaining({ check: "backup-written", ok: true })]));
    expect(boot.mock.calls.map(([dir]) => dir)).toEqual([release, codeDir]);
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
