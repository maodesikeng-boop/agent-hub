import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { AGENT_VENDORS, VENDOR_SPECS } from "../../shared/index.ts";
import { makeHarness, type Harness } from "./test-helpers.ts";
import { SANDBOX_EXEC, WRITE_SCOPE_ENFORCERS, seatbeltProfile, wrapInSeatbelt } from "./write-scope.ts";

const scope = { dataDir: "/Users/u/.agent-hub", writableDirs: ["/Users/u/.agent-hub/worktrees/1/2"] };
const base = { command: "/bin/agent", args: ["--x", "y"] };

describe("WRITE_SCOPE_ENFORCERS", () => {
  it("VENDOR_SPECS 里的每家都有", () => {
    expect(Object.keys(WRITE_SCOPE_ENFORCERS).sort()).toEqual([...AGENT_VENDORS].sort());
    expect(Object.keys(VENDOR_SPECS).sort()).toEqual([...AGENT_VENDORS].sort());
  });

  it("项目经理（没有可写范围）每家都原样起", () => {
    for (const vendor of AGENT_VENDORS) expect(WRITE_SCOPE_ENFORCERS[vendor].spawnCommand(base, null), vendor).toEqual(base);
  });

  it("claude、agy 的 Worker 在 macOS 上包一层 sandbox-exec；codex 不包（自己的沙箱管，不能嵌套）", () => {
    const wrapped = { command: SANDBOX_EXEC, args: ["-p", seatbeltProfile(scope), "/bin/agent", "--x", "y"] };
    expect(wrapInSeatbelt(base, scope, "darwin")).toEqual(wrapped);
    expect(wrapInSeatbelt(base, scope, "linux")).toEqual(base);
    if (process.platform === "darwin") {
      expect(WRITE_SCOPE_ENFORCERS.claude.spawnCommand(base, scope)).toEqual(wrapped);
      expect(WRITE_SCOPE_ENFORCERS.agy.spawnCommand(base, scope)).toEqual(wrapped);
    }
    expect(WRITE_SCOPE_ENFORCERS.codex.spawnCommand(base, scope)).toEqual(base);
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
describe.runIf(process.platform === "darwin" && existsSync(SANDBOX_EXEC))("真 sandbox-exec", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ah-scope-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("编辑（写文件）和 shell（mkdir、重定向）都拦得住，工作目录照常", () => {
    const dataDir = join(root, "home");
    const own = join(dataDir, "worktrees", "1", "2");
    mkdirSync(own, { recursive: true });
    mkdirSync(join(dataDir, "state"));
    mkdirSync(join(dataDir, "worktrees", "1", "3"));
    const run = wrapInSeatbelt(
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
describe.runIf(process.platform === "darwin" && existsSync(SANDBOX_EXEC))("claude 驱动起进程", () => {
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
