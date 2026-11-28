import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVIEW_HOOKS_DIR, REVIEW_PRE_PUSH_HOOK, type AgentSessionRow } from "../../shared/index.ts";
import { createLaunchPreparer } from "../launch.ts";
import { workerContext } from "../test-helpers.ts";
import { writeExecutableFileAtomicSync, type WriteExecutableFileOptions } from "./index.ts";

describe("writeExecutableFileAtomicSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fusa-exec-atomic-")));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a new executable script with exact mode, leaves no temp files, and executes cleanly", () => {
    const target = join(dir, "run.sh");
    const content = "#!/bin/sh\necho atomic-ok\n";
    const changed = writeExecutableFileAtomicSync(target, content, { mode: 0o755 });

    expect(changed).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(content);
    expect(readdirSync(dir)).toEqual(["run.sh"]);
    if (process.platform !== "win32") {
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(execFileSync(target, [], { encoding: "utf8" }).trim()).toBe("atomic-ok");
    }
  });

  it("is an idempotent no-op preserving the inode when content and mode already match", () => {
    const target = join(dir, "same.sh");
    const content = "#!/bin/sh\nexit 0\n";
    expect(writeExecutableFileAtomicSync(target, content, { mode: 0o755 })).toBe(true);
    const before = statSync(target, { bigint: true });

    expect(writeExecutableFileAtomicSync(target, content, { mode: 0o755 })).toBe(false);
    const after = statSync(target, { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(readdirSync(dir)).toEqual(["same.sh"]);
  });

  it("publishes a brand-new inode via atomic rename when content or POSIX mode changes", () => {
    const target = join(dir, "replace.sh");
    expect(writeExecutableFileAtomicSync(target, "#!/bin/sh\necho v1\n", { mode: 0o755 })).toBe(true);
    const ino1 = statSync(target, { bigint: true }).ino;

    expect(writeExecutableFileAtomicSync(target, "#!/bin/sh\necho v2\n", { mode: 0o755 })).toBe(true);
    const ino2 = statSync(target, { bigint: true }).ino;
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho v2\n");
    if (process.platform !== "win32") {
      expect(ino2).not.toBe(ino1);
      chmodSync(target, 0o644);
      expect(writeExecutableFileAtomicSync(target, "#!/bin/sh\necho v2\n", { mode: 0o755 })).toBe(true);
      const ino3 = statSync(target, { bigint: true }).ino;
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(ino3).not.toBe(ino2);
    }
    expect(readdirSync(dir)).toEqual(["replace.sh"]);
  });

  it("replaces an existing symlink without mutating the symlink target", () => {
    if (process.platform === "win32") return;
    const victim = join(dir, "victim.txt");
    const link = join(dir, "hook");
    writeFileSync(victim, "untouched\n");
    symlinkSync(victim, link);

    expect(writeExecutableFileAtomicSync(link, "#!/bin/sh\nexit 1\n", { mode: 0o755 })).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(lstatSync(link).isFile()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("untouched\n");
    expect(readFileSync(link, "utf8")).toBe("#!/bin/sh\nexit 1\n");
  });

  it("retries transient Windows rename locks and cleans up temp files on unrecoverable failure", () => {
    const target = join(dir, "win-shim");
    let attempts = 0;
    const winOpts: WriteExecutableFileOptions = {
      platform: "win32",
      delaysMs: [0, 0, 0],
      renameImpl: (src, dst) => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("busy") as NodeJS.ErrnoException;
          err.code = "EBUSY";
          throw err;
        }
        writeFileSync(dst, readFileSync(src, "utf8"));
        rmSync(src);
      },
    };
    const renamed = writeExecutableFileAtomicSync(target, "#!/bin/sh\nexit 0\n", winOpts);
    expect(renamed).toBe(true);
    expect(attempts).toBe(3);

    const blockerDir = join(dir, "non-empty-dir");
    mkdirSync(blockerDir);
    writeFileSync(join(blockerDir, "keep"), "x");
    expect(() => writeExecutableFileAtomicSync(blockerDir, "#!/bin/sh\nexit 0\n")).toThrow();
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("prepareLaunch review-hooks/pre-push atomic publication", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "fusa-launch-hook-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("replaces review-hooks/pre-push atomically on drift, skips rewriting when unchanged, and never causes ETXTBSY under concurrent execution", async () => {
    const dataDir = join(root, "data");
    const launchDir = join(dataDir, "state", "launch");
    const sessionTmpDir = join(dataDir, "session-tmp");
    const cwd = join(root, "wt");
    mkdirSync(launchDir, { recursive: true });
    mkdirSync(sessionTmpDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const prepare = createLaunchPreparer({
      sessionTmp: { allocate: () => sessionTmpDir },
      launchDir,
      dataDir,
      stateDir: join(dataDir, "state"),
      osSandboxed: true,
      worktreesDir: join(dataDir, "worktrees"),
      getLaunchContext: () => workerContext({ worktreePath: cwd, branch: null, review: { branch: "hub/1-impl", snapshot: null } }),
      tokens: { issue: () => "tok" },
      hubSock: join(dataDir, "run", "hub.sock"),
      hubBinDir: join(dataDir, "run", "bin"),
      prepareOsSandbox: async () => {},
    });

    const session = { id: 7, role: "worker", vendor: "claude", cwd, addDirs: [] } as unknown as AgentSessionRow;
    const files1 = await prepare(session);
    const hooksDir = join(launchDir, "7", REVIEW_HOOKS_DIR);
    const hookPath = join(hooksDir, "pre-push");
    expect(files1.env.GIT_CONFIG_VALUE_0).toBe(hooksDir);
    expect(readFileSync(hookPath, "utf8")).toBe(REVIEW_PRE_PUSH_HOOK);

    const ino1 = statSync(hookPath, { bigint: true }).ino;

    if (process.platform !== "win32") {
      chmodSync(hookPath, 0o644);
      await prepare(session);
      const inoAfterDrift = statSync(hookPath, { bigint: true }).ino;
      expect(statSync(hookPath).mode & 0o777).toBe(0o755);
      expect(inoAfterDrift).not.toBe(ino1);

      await prepare(session);
      expect(statSync(hookPath, { bigint: true }).ino).toBe(inoAfterDrift);

      const iterations = 40;
      const runner = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn(
          "sh",
          [
            "-c",
            `i=0; while [ "$i" -lt ${iterations} ]; do
              out=$("$1" 2>&1)
              rc=$?
              if [ "$rc" -ne 1 ]; then echo "unexpected rc=$rc out=$out" >&2; exit 2; fi
              case "$out" in
                *"审查步骤只查不修：不能推送"*) ;;
                *) echo "bad output: $out" >&2; exit 3 ;;
              esac
              i=$((i + 1))
            done`,
            "_",
            hookPath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("close", (code) => resolve({ code, stderr }));
      });

      const prepLoop = (async () => {
        for (let i = 0; i < 20; i += 1) {
          await prepare(session);
        }
      })();

      const [runResult] = await Promise.all([runner, prepLoop]);
      expect(runResult.code, runResult.stderr).toBe(0);
      expect(runResult.stderr).not.toContain("Text file busy");
      expect(readdirSync(hooksDir)).toEqual(["pre-push"]);
    }
  });
});
