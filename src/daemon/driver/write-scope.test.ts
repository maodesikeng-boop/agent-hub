import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AGENT_VENDORS, DriverError, VENDOR_SPECS } from "../../shared/index.ts";
import { isAlive, signalChild, termGroupAfterExit, waitForExit } from "./process.ts";
import { FAKE_CLAUDE, makeHarness, realSleep, type Harness } from "./test-helpers.ts";
import {
  BWRAP,
  OS_SANDBOX_BACKENDS,
  SANDBOX_EXEC,
  SECRET_SCAN_MAX_ENTRIES,
  SECRET_SCAN_MAX_MATCHES,
  SECRET_SCAN_MAX_MS,
   WORKER_NEEDS_OS_SANDBOX_MESSAGE,
  WRITE_SCOPE_ENFORCERS,
  bwrapArgs,
  bwrapProbeArgs,
  expandWritableFileGlobs,
  osSandboxAvailable,
  readonlyBwrapArgs,
  readonlySeatbeltProfile,
  resetOsSandboxCacheForTest,
  scanSecretGlobs,
  secretGlobRegex,
  seatbeltProfile,
  spawnInWriteScope,
  wrapInOsSandbox,
  wrapInReadonlyOsSandbox,
  type ReadonlySandboxInput,
} from "./write-scope.ts";

const scope = { dataDir: "/Users/u/.agent-hub", writableDirs: ["/Users/u/.agent-hub/worktrees/1/2"] };
const base = { command: "/bin/agent", args: ["--x", "y"] };
const canRunSandboxExec =
  process.platform === "darwin" &&
  (() => {
    try {
      execFileSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)", "/usr/bin/true"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

describe("WRITE_SCOPE_ENFORCERS", () => {
  it("VENDOR_SPECS 里的每家都有", () => {
    expect(Object.keys(WRITE_SCOPE_ENFORCERS).sort()).toEqual([...AGENT_VENDORS].sort());
    expect(Object.keys(VENDOR_SPECS).sort()).toEqual([...AGENT_VENDORS].sort());
  });

  it("项目经理（没有可写范围）每家都原样起", () => {
    for (const vendor of AGENT_VENDORS) expect(WRITE_SCOPE_ENFORCERS[vendor].spawnCommand(base, null, "darwin"), vendor).toEqual({ ...base, osSandboxed: false });
  });

  it("macOS 上包 sandbox-exec，Linux 上包 bwrap（codex 换 externalSandbox，不再自己起沙箱）；未支持系统不包", () => {
    const darwinOpts = { available: true };
    const linuxOpts = { available: true, uid: 1000, exists: () => true, realpath: (p: string) => p };
    const wrappedDarwin = { command: SANDBOX_EXEC, args: ["-p", seatbeltProfile(scope), "/bin/agent", "--x", "y"], osSandboxed: true };
    const wrappedLinux = { command: BWRAP, args: bwrapArgs(base, scope, linuxOpts), osSandboxed: true };
    expect(wrapInOsSandbox(base, scope, "darwin", darwinOpts)).toEqual(wrappedDarwin);
    expect(wrapInOsSandbox(base, scope, "linux", linuxOpts)).toEqual(wrappedLinux);
    expect(wrapInOsSandbox(base, scope, "linux", { available: false })).toEqual({ ...base, osSandboxed: false });
    expect(wrapInOsSandbox(base, scope, "win32")).toEqual({ ...base, osSandboxed: false });
    expect(Object.keys(OS_SANDBOX_BACKENDS).sort()).toEqual(["darwin", "linux"]);
    for (const vendor of AGENT_VENDORS) {
      const off = WRITE_SCOPE_ENFORCERS[vendor].ownSandboxOffArgs;
      expect(WRITE_SCOPE_ENFORCERS[vendor].spawnCommand(base, scope, "darwin", darwinOpts), vendor).toEqual({
        ...wrappedDarwin,
        args: ["-p", seatbeltProfile(scope), "/bin/agent", ...off, "--x", "y"],
      });
      expect(WRITE_SCOPE_ENFORCERS[vendor].spawnCommand(base, scope, "linux", linuxOpts), vendor).toEqual({
        command: BWRAP,
        args: bwrapArgs({ command: "/bin/agent", args: [...off, "--x", "y"] }, scope, linuxOpts),
        osSandboxed: true,
      });
      expect(WRITE_SCOPE_ENFORCERS[vendor].spawnCommand(base, scope, "linux", { available: false }), vendor).toEqual({ ...base, osSandboxed: false });
    }
    // 包进去的进程不能再开自带的沙箱：agy 在命令行上关（claude 在设置文件、codex 在 sandboxPolicy 里关）
    expect(WRITE_SCOPE_ENFORCERS.agy.ownSandboxOffArgs).toEqual(["--settings", '{"enableTerminalSandbox":false}']);
    expect(WRITE_SCOPE_ENFORCERS.claude.ownSandboxOffArgs).toEqual([]);
    expect(WRITE_SCOPE_ENFORCERS.codex.ownSandboxOffArgs).toEqual([]);
  });
});

describe("osSandboxAvailable（探测与单向缓存）", () => {
  afterEach(() => resetOsSandboxCacheForTest());

  it("Linux 探测：只缓存 true，不缓存 false（跑完 linux-sandbox-setup.sh 后下次派活立即生效）", () => {
    expect(bwrapProbeArgs(1000)).toEqual([
      "--unshare-user",
      "--disable-userns",
      "--unshare-pid",
      "--bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
      "--perms",
      "0700",
      "--tmpfs",
      "/run/user/1000",
      "--",
      "/bin/true",
    ]);
    let probes = 0;
    let ready = false;
    const probe = () => {
      probes++;
      return ready;
    };
    expect(osSandboxAvailable("linux", { probe })).toBe(false);
    expect(osSandboxAvailable("linux", { probe })).toBe(false);
    expect(probes).toBe(2); // false 不缓存，每次重测

    ready = true;
    expect(osSandboxAvailable("linux", { probe })).toBe(true);
    expect(osSandboxAvailable("linux", { probe })).toBe(true);
    expect(probes).toBe(3); // true 命中模块级缓存，后续 0 开销
  });
});

describe("spawnInWriteScope", () => {
  it("没有 OS 沙箱的 Worker：不再退回规则兜底，直接抛 DriverError(spawn_failed) 拒绝启动并提示修复脚本", () => {
    for (const vendor of AGENT_VENDORS) {
      const lines: string[] = [];
      let thrown: unknown;
      try {
        spawnInWriteScope(vendor, base, scope, (l) => lines.push(l), "session 3", "linux", { available: false });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, vendor).toBeInstanceOf(DriverError);
      expect((thrown as DriverError).code, vendor).toBe("spawn_failed");
      expect((thrown as DriverError).message, vendor).toBe(`spawn_failed: ${WORKER_NEEDS_OS_SANDBOX_MESSAGE}`);
      expect((thrown as DriverError).message, vendor).toContain("sudo scripts/linux-sandbox-setup.sh");
      expect(lines, vendor).toEqual([]);
    }
  });

  it("包进了沙箱（macOS 或 Linux）、或没有可写范围（项目经理）照常返回", () => {
    const lines: string[] = [];
    expect(spawnInWriteScope("claude", base, scope, (l) => lines.push(l), "session 3", "darwin", { available: true }).osSandboxed).toBe(true);
    expect(
      spawnInWriteScope("claude", base, scope, (l) => lines.push(l), "session 3", "linux", {
        available: true,
        uid: 1000,
        exists: () => true,
        realpath: (p) => p,
      }).osSandboxed,
    ).toBe(true);
    expect(spawnInWriteScope("agy", base, null, (l) => lines.push(l), "session 3", "darwin")).toEqual({ ...base, osSandboxed: false });
    expect(spawnInWriteScope("codex", base, null, (l) => lines.push(l), "session 3", "linux", { available: false })).toEqual({ ...base, osSandboxed: false });
    expect(lines).toEqual([]);
  });
});

describe("seatbeltProfile", () => {
  it("别的放行，数据目录禁写，之后放行自己的工作目录（后面的规则压过前面的）", () => {
    expect(seatbeltProfile(scope)).toBe(
      [
        "(version 1)",
        "(allow default)",
        '(deny file-write* (subpath "/Users/u/.agent-hub"))',
        '(allow file-write* (subpath "/Users/u/.agent-hub/worktrees/1/2"))',
      ].join("\n"),
    );
  });

  it("在主文件夹干活的 Worker：只禁写数据目录", () => {
    expect(seatbeltProfile({ dataDir: "/d", writableDirs: [] })).toBe('(version 1)\n(allow default)\n(deny file-write* (subpath "/d"))');
  });

  it('路径里的 " 和 \\ 要转义', () => {
    expect(seatbeltProfile({ dataDir: '/a"b\\c', writableDirs: [] })).toContain('(subpath "/a\\"b\\\\c")');
  });
});

// 真 sandbox-exec：数据目录里别处（含新建目录、state/、别的 worktree）写不了，自己的工作目录和临时目录能写
describe.runIf(canRunSandboxExec)("真 sandbox-exec", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-scope-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("编辑（写文件）和 shell（mkdir、重定向）都拦得住，工作目录照常", () => {
    const dataDir = join(root, "home");
    const own = join(dataDir, "worktrees", "1", "2");
    mkdirSync(own, { recursive: true });
    mkdirSync(join(dataDir, "state"));
    mkdirSync(join(dataDir, "worktrees", "1", "3"));
    const run = wrapInOsSandbox(
      {
        command: "/bin/sh",
        args: [
          "-c",
          'mkdir "$D/shots"; echo x > "$D/state/t"; echo x > "$D/worktrees/1/3/t"; mkdir "$D/WORKTREES/1/x"; ' +
            'echo ok > "$O/a.txt" && mkdir -p "$O/node_modules/p" && echo ok > "$O/../2/b.txt" && echo ok > "$TMPDIR/ah-scope-probe" && echo done',
        ],
      },
      { dataDir, writableDirs: [own] },
      "darwin",
    );
    const out = execFileSync(run.command, run.args, {
      env: { ...process.env, D: dataDir, O: own, TMPDIR: root },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    expect(out.trim()).toBe("done");
    expect(existsSync(join(dataDir, "shots"))).toBe(false);
    expect(existsSync(join(dataDir, "state", "t"))).toBe(false);
    expect(existsSync(join(dataDir, "worktrees", "1", "3", "t"))).toBe(false);
    expect(existsSync(join(dataDir, "worktrees", "1", "x"))).toBe(false);
    expect(existsSync(join(own, "a.txt"))).toBe(true);
    expect(existsSync(join(own, "b.txt"))).toBe(true);
    expect(existsSync(join(own, "node_modules", "p"))).toBe(true);
  });
});

// 驱动层真的用上了：claude 驱动起 Worker 时包了沙箱（假 claude 启动时往数据目录里写一个文件，写不成），项目经理不包
describe.runIf(canRunSandboxExec)("claude 驱动起进程", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
  });
  const user = (id: number, text: string) => ({ messageIds: [id], source: "user" as const, text });

  for (const [role, scoped] of [["worker", true], ["pm", false]] as const) {
    it(`${role}：数据目录里${scoped ? "写不成" : "能写"}，这一轮照常跑完`, async () => {
      h = makeHarness();
      const dataDir = join(realpathSync.native(h.dir), "home");
      const cwd = join(dataDir, "worktrees", "1", "2");
      mkdirSync(cwd, { recursive: true });
      const probe = join(dataDir, "probe.txt");
      h.launch.env = { FAKE_CLAUDE_PROBE: probe };
      if (scoped) h.launch.writeScope = { dataDir, writableDirs: [cwd] };
      const s = h.addSession({ role, cwd });
      await h.driver.send(s.id, user(1, "hi"));
      const ended = await h.waitFor("turn.ended");
      expect(ended.ok).toBe(true);
      expect(h.log().find((e) => e.kind === "probe")).toMatchObject(scoped ? { ok: false, code: "EPERM" } : { ok: true });
      expect(existsSync(probe)).toBe(!scoped);
    });
  }
});

// 只读 Worker 的外层沙箱（agy 用，设计 4.1）：哪里都不能写，会话私有临时目录、运行时目录、缓存目录除外，密钥禁读
const roInput: ReadonlySandboxInput = {
  tmpDir: "/private/tmp/ro-1",
  writableDirs: ["/Users/u/.gemini/antigravity-cli/bin", "/Users/u/.cache"],
  writableFileRegexes: ["^/Users/u/\\.gemini/antigravity-cli/conversation_summaries\\.db[^/]*$"],
  secretPaths: ["/Users/u/.ssh"],
  secretGlobs: ["**/.env", "**/.env.*", "**/id_rsa*"],
};

describe("readonlySeatbeltProfile", () => {
  it("别的放行，哪里都不能写，再放行设备文件、临时目录、运行时和缓存目录、具体文件，最后密钥禁读（后面的规则压过前面的）", () => {
    expect(readonlySeatbeltProfile(roInput).split("\n")).toEqual([
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
      '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
      '(allow file-write* (subpath "/private/tmp/ro-1"))',
      '(allow file-write* (subpath "/Users/u/.gemini/antigravity-cli/bin"))',
      '(allow file-write* (subpath "/Users/u/.cache"))',
      '(allow file-write* (regex #"^/Users/u/\\.gemini/antigravity-cli/conversation_summaries\\.db[^/]*$"))',
      '(deny file-read* (subpath "/Users/u/.ssh"))',
      '(deny file-read* (regex #"/\\.env$"))',
      '(deny file-read* (regex #"/\\.env\\.[^/]*$"))',
      '(deny file-read* (regex #"/id_rsa[^/]*$"))',
    ]);
  });

  it("密钥通配转正则：开头的 **/ 去掉，* 不跨目录，点要转义", () => {
    expect(secretGlobRegex("**/.env")).toBe("/\\.env$");
    expect(secretGlobRegex("**/*.pem")).toBe("/[^/]*\\.pem$");
    expect(secretGlobRegex("**/id_ed25519*")).toBe("/id_ed25519[^/]*$");
  });

  it("wrapInReadonlyOsSandbox：macOS 包 sandbox-exec，Linux 包 bwrap；沙箱不可用时原样返回、osSandboxed 是 false（调用方报错）", () => {
    expect(wrapInReadonlyOsSandbox(base, roInput, "darwin", { available: true })).toEqual({
      command: SANDBOX_EXEC,
      args: ["-p", readonlySeatbeltProfile(roInput), "/bin/agent", "--x", "y"],
      osSandboxed: true,
    });
    expect(wrapInReadonlyOsSandbox(base, roInput, "linux", { available: false })).toEqual({ ...base, osSandboxed: false });
    expect(wrapInReadonlyOsSandbox(base, roInput, "win32")).toEqual({ ...base, osSandboxed: false });
  });
});

describe("bwrapArgs 与 readonlyBwrapArgs（Linux bubblewrap 参数纯函数）", () => {
  it("bwrapArgs：顺序为 --unshare-user --disable-userns --unshare-pid --proc /proc --bind / / --dev-bind /dev /dev --perms 0700 --tmpfs /run/user/<uid> --ro-bind <dataDir> --bind <writableDir> -- <cli> <args>；做 realpath 且跳过不存在路径", () => {
    const existing = new Set(["/real/home/.agent-hub", "/real/home/.agent-hub/worktrees/1/2"]);
    const real = (p: string) => p.replace(/^\/Users\/u/, "/real/home");
    const args = bwrapArgs(
      base,
      {
        dataDir: "/Users/u/.agent-hub",
        writableDirs: ["/Users/u/.agent-hub/worktrees/1/2", "/Users/u/.agent-hub/worktrees/1/missing"],
      },
      { uid: 1001, exists: (p) => existing.has(p), realpath: real },
    );
    expect(args).toEqual([
      "--unshare-user",
      "--disable-userns",
      "--unshare-pid",
      "--bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
      "--perms",
      "0700",
      "--tmpfs",
      "/run/user/1001",
      "--ro-bind",
      "/real/home/.agent-hub",
      "/real/home/.agent-hub",
      "--bind",
      "/real/home/.agent-hub/worktrees/1/2",
      "/real/home/.agent-hub/worktrees/1/2",
      "--",
      "/bin/agent",
      "--x",
      "y",
    ]);
  });

  it("readonlyBwrapArgs：--ro-bind / / 起步，放开 tmpDir、已存在 writableDirs 与展开的 writableFileGlobs，敏感目录用 --tmpfs、敏感文件用 --ro-bind /dev/null", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-bwrap-ro-unit-")));
    try {
      const tmp = join(dir, "tmp");
      const cache = join(dir, "cache");
      const binDir = join(dir, "cli", "bin");
      const mcpServerDir = join(dir, "cli", "mcp", "srv");
      const secretSubdir = join(dir, ".ssh");
      for (const d of [tmp, cache, binDir, mcpServerDir, secretSubdir]) mkdirSync(d, { recursive: true });
      const agentapi = join(binDir, "agentapi-v1");
      const webm = join(binDir, "webm_encoder");
      const mcpTool = join(mcpServerDir, "tool.json");
      const secretFile = join(dir, ".env");
      for (const f of [agentapi, webm, mcpTool, secretFile]) writeFileSync(f, "x");

      const input: ReadonlySandboxInput = {
        tmpDir: tmp,
        writableDirs: [cache, join(dir, "nonexistent-dir")],
        writableFileGlobs: [join(binDir, "agentapi*"), join(dir, "cli", "mcp", "*"), join(dir, "cli", "mcp", "*", "*")],
        writableFileRegexes: [],
        secretPaths: [secretSubdir, secretFile, join(dir, "nonexistent-secret")],
        secretGlobs: ["**/.env"],
      };
      expect(expandWritableFileGlobs(input.writableFileGlobs!)).toEqual([agentapi, mcpTool]);
      const args = readonlyBwrapArgs(base, input, { uid: 1002 });
      expect(args).toEqual([
        "--unshare-user",
        "--disable-userns",
        "--unshare-pid",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev-bind",
        "/dev",
        "/dev",
        "--perms",
        "0700",
        "--tmpfs",
        "/run/user/1002",
        "--bind",
        tmp,
        tmp,
        "--bind",
        cache,
        cache,
        "--bind",
        agentapi,
        agentapi,
        "--bind",
        mcpTool,
        mcpTool,
        "--tmpfs",
        secretSubdir,
        "--ro-bind",
        "/dev/null",
        secretFile,
        "--",
        "/bin/agent",
        "--x",
        "y",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("scanSecretGlobs（只读通配扫描与硬上限 fail-closed）", () => {
  it("非递归遍历去重后的 roots，匹配 .env / .env.* / *.pem / id_rsa*，跳过 .git、node_modules 与符号链接目录", () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-secret-scan-")));
    try {
      const dir = join(parent, "workspace");
      const sub = join(dir, "packages", "web");
      const gitDir = join(dir, ".git");
      const nmDir = join(dir, "node_modules", "pkg");
      const outside = join(parent, "outside");
      for (const d of [sub, gitDir, nmDir, outside]) mkdirSync(d, { recursive: true });
      writeFileSync(join(dir, ".env"), "A=1");
      writeFileSync(join(sub, ".env.local"), "B=2");
      writeFileSync(join(sub, "cert.pem"), "C=3");
      writeFileSync(join(sub, "id_rsa_deploy"), "D=4");
      writeFileSync(join(sub, "normal.ts"), "export {};");
      writeFileSync(join(gitDir, ".env"), "IGNORED=1");
      writeFileSync(join(nmDir, ".env"), "IGNORED=2");
      writeFileSync(join(outside, ".env"), "OUTSIDE=1");
      // 符号链接目录（含指回外部目录与父目录的环）必须跳过
      symlinkSync(outside, join(sub, "linked-outside"));
      symlinkSync(dir, join(sub, "loop-root"));

      const found = scanSecretGlobs([dir, dir], ["**/.env", "**/.env.*", "**/*.pem", "**/id_rsa*"]);
      expect(found.sort()).toEqual([join(dir, ".env"), join(sub, ".env.local"), join(sub, "cert.pem"), join(sub, "id_rsa_deploy")].sort());
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("硬上限常量与超限 fail-closed：目录项超 20,000、耗时超 200ms、命中超 500 均立即抛 DriverError(spawn_failed)", () => {
    expect(SECRET_SCAN_MAX_ENTRIES).toBe(20_000);
    expect(SECRET_SCAN_MAX_MS).toBe(200);
    expect(SECRET_SCAN_MAX_MATCHES).toBe(500);

    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-secret-limits-")));
    try {
      for (let i = 0; i < 6; i++) writeFileSync(join(dir, `.env.part${i}`), "SECRET=1");

      // 1) 目录项超限
      expect(() => scanSecretGlobs([dir], ["**/.env.*"], { maxEntries: 3 })).toThrowError(DriverError);
      expect(() => scanSecretGlobs([dir], ["**/.env.*"], { maxEntries: 3 })).toThrow(/超出目录项上限（超过 3 项/);

      // 2) 敏感文件命中数超限
      expect(() => scanSecretGlobs([dir], ["**/.env.*"], { maxMatches: 4 })).toThrowError(DriverError);
      expect(() => scanSecretGlobs([dir], ["**/.env.*"], { maxMatches: 4 })).toThrow(/超出命中数量上限（超过 4 个/);

      // 3) 扫描耗时超限
      let clock = 1_000;
      expect(() =>
        scanSecretGlobs([dir], ["**/.env.*"], {
          maxMs: 200,
          now: () => {
            clock += 150;
            return clock;
          },
        }),
      ).toThrow(/耗时超限（超过 200 ms/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// 真 sandbox-exec：只读 profile 下哪都写不了（含命令行三种写法、新建目录），临时目录、运行时目录能写，读照常，密钥读不了
describe.runIf(canRunSandboxExec)("真 sandbox-exec：只读", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-ro-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("写不了任何地方，私有临时目录和运行时目录能写，读文件和只读命令照常，密钥读不了", () => {
    const work = join(root, "work");
    const tmp = join(root, "tmp");
    const runtime = join(root, "runtime");
    const secretDir = join(root, "secret");
    for (const d of [work, tmp, runtime, secretDir]) mkdirSync(d, { recursive: true });
    writeFileSync(join(work, "note.txt"), "NOTE");
    writeFileSync(join(work, ".env"), "SECRET=1");
    writeFileSync(join(secretDir, "key"), "K");
    const run = wrapInReadonlyOsSandbox(
      {
        command: "/bin/sh",
        args: [
          "-c",
          'echo x > "$W/w1.txt"; python3 -c "open(\'$W/w2.txt\',\'w\').write(\'x\')" 2>/dev/null; touch "$W/w3.txt"; mkdir "$W/dir"; echo x > "$R/../outside.txt"; ' +
            'cat "$W/.env" >/dev/null 2>&1 && echo ENV_READ; cat "$S/key" >/dev/null 2>&1 && echo KEY_READ; ' +
            'cat "$W/note.txt" && echo ok > "$TMPDIR/p" && echo ok > "$R/p" && echo done',
        ],
      },
      { tmpDir: tmp, writableDirs: [runtime], writableFileRegexes: [], secretPaths: [secretDir], secretGlobs: ["**/.env"] },
      "darwin",
    );
    const out = execFileSync(run.command, run.args, {
      env: { ...process.env, W: work, R: runtime, S: secretDir, TMPDIR: tmp },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    expect(out.trim()).toBe("NOTEdone");
    for (const f of ["w1.txt", "w2.txt", "w3.txt", "dir"]) expect(existsSync(join(work, f)), f).toBe(false);
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
    expect(existsSync(join(tmp, "p"))).toBe(true);
    expect(existsSync(join(runtime, "p"))).toBe(true);
  });
});
