import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_HUB_SOCK, ENV_HUB_TOKEN } from "../../shared/hub.ts";
import { ForkUnsupportedError, type ForkSource } from "../../daemon/handover/forker.ts";
import { buildPiSkillArgs, createPiComposer, parsePiCommands } from "./composer.ts";
import { writeFakePiBinary } from "./fixtures/fake-pi.ts";
import { PI_NATIVE_FORKER_ID, createPiForker } from "./handover.ts";
import * as piPaths from "./paths.ts";
import { piSessionDirName, piSessionFiles, piSessionsRoot, piTranscriptPath } from "./transcript.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-hub-pi-aux-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Pi 输入框命令与技能加载（composer.ts）", () => {
  it("buildPiSkillArgs：只为已存在的 .agents/skills 加 --skill，去重且绝不加 --approve", () => {
    const dir = makeTempDir();
    const projectA = join(dir, "proj-a");
    const projectB = join(dir, "proj-b");
    mkdirSync(join(projectA, ".agents", "skills"), { recursive: true });
    mkdirSync(projectB, { recursive: true });

    const args = buildPiSkillArgs(projectA, [projectA, projectB]);
    expect(args).toEqual(["--skill", join(projectA, ".agents", "skills")]);
    expect(args).not.toContain("--approve");
  });

  it("parsePiCommands 与 createPiComposer：通过 RPC get_commands 获取技能命令并补入内置 compact", async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
    const fake = writeFakePiBinary(dir, {
      commands: [
        { name: "skill:demo-skill", description: "项目技能", source: "skill" },
        { name: "review", description: "代码审查模板", argumentHint: "<path>" },
      ],
    });

    const composer = createPiComposer({
      executablePath: fake.binPath,
      env: { FAKE_PI_SCRIPT: fake.scriptPath, FAKE_PI_LOG: fake.logPath },
      timeoutMs: 3_000,
    });

    const cmds = await composer.queryCommands({ cwd: dir, addDirs: [] }, new AbortController().signal);
    expect(cmds.map((c) => c.name)).toEqual(["skill:demo-skill", "review", "compact"]);
    expect(cmds.find((c) => c.name === "review")?.argumentHint).toBe("<path>");
    expect(cmds.find((c) => c.name === "compact")?.builtin).toBe(true);

    const argvLog = fake.readLogs().find((e) => e.kind === "argv");
    expect(argvLog?.argv).toContain("--skill");
    expect(argvLog?.argv).toContain(join(dir, ".agents", "skills"));
    expect(argvLog?.argv).not.toContain("--approve");
    expect(argvLog?.argv).toContain("--no-approve");
    expect(parsePiCommands("not-an-object")).toBeNull();
  });
});

describe("Pi 会话记录路径与凭据环境变量（transcript.ts & paths.ts）", () => {
  it("piTranscriptPath：支持软链工作目录（含已删除的末端 worktree）与 300+ 子目录有界兜底", () => {
    const root = makeTempDir();
    const sessionsDir = join(root, "sessions");
    const realBase = join(root, "real-worktrees");
    const linkBase = join(root, "link-worktrees");
    mkdirSync(realBase, { recursive: true });
    symlinkSync(realBase, linkBase);

    // 模拟已删除的 Worker worktree 路径（父目录仍是软链）
    const deletedWorkerCwd = join(linkBase, "7", "365");
    const realDeletedCwd = join(realBase, "7", "365");
    const encodedDir = join(sessionsDir, piSessionDirName(realDeletedCwd));
    mkdirSync(encodedDir, { recursive: true });
    const olderFile = join(encodedDir, "2026-11-10T01-00-00-000Z_sess-abc.jsonl");
    const newerFile = join(encodedDir, "2026-11-11T01-00-00-000Z_sess-abc.jsonl");
    writeFileSync(olderFile, "{}\n");
    writeFileSync(newerFile, "{}\n");

    const env = { PI_CODING_AGENT_SESSION_DIR: sessionsDir };
    expect(piSessionsRoot({ env })).toBe(sessionsDir);
    expect(piTranscriptPath({ vendor: "pi", cwd: deletedWorkerCwd, vendorSessionId: "sess-abc" }, { env })).toBe(
      newerFile,
    );
    expect(piSessionFiles({ vendor: "pi", cwd: deletedWorkerCwd, vendorSessionId: "sess-abc" }, { env })).toEqual([
      newerFile,
      olderFile,
    ]);

    // 模拟 320 个历史 Worker 子目录兜底查找
    for (let i = 1; i <= 320; i++) {
      mkdirSync(join(sessionsDir, `--other-worker-${String(i).padStart(3, "0")}--`), { recursive: true });
    }
    const targetSub = join(sessionsDir, "--other-worker-315--");
    const fallbackFile = join(targetSub, "2026-11-11T02-00-00-000Z_sess-moved.jsonl");
    writeFileSync(fallbackFile, "{}\n");
    expect(piTranscriptPath({ vendor: "pi", cwd: "/completely/moved", vendorSessionId: "sess-moved" }, { env })).toBe(
      fallbackFile,
    );

    // 非法路径穿越 ID 一律拒绝
    expect(piSessionFiles({ vendor: "pi", cwd: root, vendorSessionId: "../evil" }, { env })).toEqual([]);
  });

  it("paths.ts：按名字精确列模型商密钥（含 DEEPSEEK_API_KEY），不用宽前缀误杀 *_BASE_URL 和通用工程凭据", () => {
    const cred = piPaths.credentialEnv!;
    const denied = (name: string) =>
      (cred.names ?? []).includes(name) || (cred.prefixes ?? []).some((p) => name.startsWith(p)) || (cred.pattern?.test(name) ?? false);
    for (const name of ["DEEPSEEK_API_KEY", "OPENROUTER_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "COPILOT_GITHUB_TOKEN", "HF_TOKEN", "CLOUDFLARE_API_TOKEN", "QWEN_TOKEN_PLAN_CN_API_KEY"]) {
      expect(denied(name), name).toBe(true);
    }
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "NPM_TOKEN", "OPENAI_BASE_URL", "GOOGLE_GEMINI_BASE_URL", "STRIPE_API_KEY", "SAFE_VARIABLE"]) {
      expect(denied(name), name).toBe(false);
    }
    expect(cred.prefixes ?? []).toEqual([]);
    expect(piPaths.installCommand).toContain("pi.dev/install.sh");
  });
});

describe("Pi 复制会话写交接（handover.ts）", () => {
  it("fork → write → remove：剥离 HUB_* 环境变量、禁掉工具与 MCP、返回回复与上下文用量并删除复制文件", async () => {
    const dir = makeTempDir();
    const agentDir = join(dir, ".pi", "agent");
    const promptFile = join(dir, "prompt.md");
    writeFileSync(promptFile, "You are PM.");

    // 预先造一份原会话记录文件
    const srcSessionDir = join(agentDir, "sessions", piSessionDirName(dir));
    mkdirSync(srcSessionDir, { recursive: true });
    const srcFile = join(srcSessionDir, "2026-11-11T00-00-00-000Z_src-sess-1.jsonl");
    writeFileSync(srcFile, '{"type":"session","version":3,"id":"src-sess-1"}\n');

    const fake = writeFakePiBinary(dir, {
      turns: [
        {
          textDeltas: ["## 交接摘要\n", "已完成第一步。"],
          usage: { input: 4200, output: 300, cacheRead: 1000, cacheWrite: 0 },
          contextTokens: 5500,
        },
      ],
    });

    const env = {
      FAKE_PI_SCRIPT: fake.scriptPath,
      FAKE_PI_LOG: fake.logPath,
      PI_CODING_AGENT_DIR: agentDir,
      [ENV_HUB_TOKEN]: "secret-hub-token",
      [ENV_HUB_SOCK]: "/tmp/hub.sock",
    };

    const forker = createPiForker({ homeDir: dir, env });
    expect(forker.id).toBe(PI_NATIVE_FORKER_ID);
    expect(forker.kind).toBe("native");

    const src: ForkSource = {
      sessionId: 1,
      vendor: "pi",
      vendorSessionId: "src-sess-1",
      cwd: dir,
      addDirs: [],
      model: "deepseek/deepseek-v4-pro",
      effort: "high",
      executablePath: fake.binPath,
      launch: {
        promptFile,
        env: { [ENV_HUB_TOKEN]: "secret-hub-token", [ENV_HUB_SOCK]: "/tmp/hub.sock" },
        fingerprint: "fp-pm",
      },
    };

    const handle = await forker.fork(src, new AbortController().signal);
    expect(handle.forkId).not.toBe("src-sess-1");

    const written = await forker.write(src, handle, "请写交接文档", new AbortController().signal);
    expect(written.text).toBe("## 交接摘要\n已完成第一步。");
    expect(written.usage).toEqual({
      input: 4200,
      cacheRead: 1000,
      cacheWrite: 0,
      output: 300,
      context: 5500,
    });

    const argvEntry = fake.readLogs().find((e) => e.kind === "argv")!;
    expect(argvEntry.argv).toContain("--fork");
    expect(argvEntry.argv).toContain(srcFile);
    expect(argvEntry.argv).toContain("--exclude-tools");
    expect(argvEntry.argv).toContain("edit,write,bash,powershell");
    expect(argvEntry.argv).toContain("--no-mcp");
    expect(argvEntry.envSnapshot?.HUB_TOKEN).toBeUndefined();
    expect(argvEntry.envSnapshot?.HUB_SOCK).toBeUndefined();

    const forkedFilesBefore = piSessionFiles({ vendor: "pi", cwd: dir, vendorSessionId: handle.forkId }, { env });
    expect(forkedFilesBefore.length).toBeGreaterThan(0);
    expect(existsSync(forkedFilesBefore[0]!)).toBe(true);

    await forker.remove(handle);
    expect(existsSync(forkedFilesBefore[0]!)).toBe(false);
  });

  it("出错时连同进程组强制结束；成功时等 pi 退出（不理 EOF 就超时强杀）再交回；参数带 --no-approve", async () => {
    const dir = makeTempDir();
    const fake = writeFakePiBinary(dir, { ignoreStdinEnd: true, turns: [{ failPromptError: "model not configured" }] });
    const env = { FAKE_PI_SCRIPT: fake.scriptPath, FAKE_PI_LOG: fake.logPath, PI_CODING_AGENT_DIR: join(dir, ".pi", "agent") };
    const forker = createPiForker({ homeDir: dir, env });
    const src: ForkSource = {
      sessionId: 3,
      vendor: "pi",
      vendorSessionId: "src-sess-3",
      cwd: dir,
      addDirs: [],
      model: null,
      effort: null,
      executablePath: fake.binPath,
      launch: { promptFile: "", env: {}, fingerprint: "fp-kill" },
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const pidOf = (nth: number) => fake.readLogs().filter((e) => e.kind === "argv")[nth]!.pid;

    // prompt 被拒：pi 还活着（不理 EOF）也要立即补杀，不留孤儿
    const failed = await forker.fork(src, new AbortController().signal);
    await expect(forker.write(src, failed, "写交接", new AbortController().signal)).rejects.toThrow(/model not configured/);
    const failedPid = pidOf(0);
    await vi.waitFor(() => expect(alive(failedPid)).toBe(false), { timeout: 3_000 });
    expect(fake.readLogs().find((e) => e.kind === "argv")?.argv).toContain("--no-approve");

    // 正常写完：交回时进程已经退出
    fake.updateScript({ ignoreStdinEnd: true, turns: [{ textDeltas: ["交接"], usage: { input: 1, output: 1 } }] });
    const ok = await forker.fork(src, new AbortController().signal);
    const written = await forker.write(src, ok, "写交接", new AbortController().signal);
    expect(written.text).toBe("交接");
    expect(alive(pidOf(1))).toBe(false);
  });

  it("找不到会话文件、编号又不像 pi 的编号（如以 - 开头）时不起进程，退回本会话交接", async () => {
    const dir = makeTempDir();
    const fake = writeFakePiBinary(dir, {});
    const forker = createPiForker({ homeDir: dir, env: { FAKE_PI_SCRIPT: fake.scriptPath, FAKE_PI_LOG: fake.logPath } });
    const src: ForkSource = {
      sessionId: 4,
      vendor: "pi",
      vendorSessionId: "--approve",
      cwd: dir,
      addDirs: [],
      model: null,
      effort: null,
      executablePath: fake.binPath,
      launch: { promptFile: "", env: {}, fingerprint: "fp-bad" },
    };
    const handle = await forker.fork(src, new AbortController().signal);
    await expect(forker.write(src, handle, "写交接", new AbortController().signal)).rejects.toBeInstanceOf(ForkUnsupportedError);
    expect(fake.readLogs()).toEqual([]);
  });

  it("原会话未落盘报 No session found 时抛出 ForkUnsupportedError 以便回退本会话交接", async () => {
    const dir = makeTempDir();
    const fake = writeFakePiBinary(dir, { failForkNotFound: true });
    const forker = createPiForker({
      homeDir: dir,
      env: { FAKE_PI_SCRIPT: fake.scriptPath, FAKE_PI_LOG: fake.logPath },
    });

    const src: ForkSource = {
      sessionId: 2,
      vendor: "pi",
      vendorSessionId: "missing-sess",
      cwd: dir,
      addDirs: [],
      model: null,
      effort: null,
      executablePath: fake.binPath,
      launch: { promptFile: "", env: {}, fingerprint: "fp-empty" },
    };

    const handle = await forker.fork(src, new AbortController().signal);
    await expect(forker.write(src, handle, "写交接", new AbortController().signal)).rejects.toBeInstanceOf(
      ForkUnsupportedError,
    );
  });
});
