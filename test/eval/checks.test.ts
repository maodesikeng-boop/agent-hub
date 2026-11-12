// 检查里认命令的小工具：读没读 diff、看没看证据（设计 4.2 的 A1、A2）。写松了、写反了在这里暴露。
import { describe, expect, it } from "vitest";
import { codeReadOf, evidenceOf, isDiffRead, shellSegments } from "./checks.ts";
import type { FactTool } from "./types.ts";

const bash = (command: string): FactTool => ({ messageId: 1, at: 0, name: "Bash", input: { command } });
const read = (file_path: string): FactTool => ({ messageId: 1, at: 0, name: "Read", input: { file_path } });

describe("shellSegments", () => {
  it("按 && ; | 换行切开，去掉开头的环境变量赋值", () => {
    expect(shellSegments(`GH_TOKEN="$(gh auth token --user x)" gh pr checks 288 | head && git diff --stat; echo ok`)).toEqual(["gh pr checks 288", "head", "git diff --stat", "echo ok"]);
  });
});

describe("isDiffRead：读完整改动算，只看名单或统计不算", () => {
  it.each([
    ["git diff main...hub/1-x", true],
    ["git -C /w diff HEAD~1", true],
    ["git show da36ed7", true],
    ["git show da36ed7:src/web/x.tsx", true],
    ["git log -p -1", true],
    ["gh pr diff 288", true],
    ["git diff --stat main", false],
    ["git diff --name-only HEAD~1", false],
    ["git show --stat da36ed7", false],
    ["git show -s --format=%s da36ed7", false],
    ["git log --oneline -5", false],
    ["gh pr diff 288 --name-only", false],
    ["git status", false],
  ])("%s → %s", (seg, expected) => {
    expect(isDiffRead(seg)).toBe(expected);
  });
});

describe("codeReadOf：验收时读代码", () => {
  const worktrees = ["/data/worktrees/1/1"];
  const changed = ["src/web/components/RouterWorkbench.tsx"];
  it("读 worktree 里的源码、读改动名单里的文件、cat 它们、完整 diff 都算", () => {
    expect(codeReadOf(read("/data/worktrees/1/1/src/a.ts"), worktrees, changed)).toContain("读文件");
    expect(codeReadOf(read("/repo/src/web/components/RouterWorkbench.tsx"), worktrees, changed)).toContain("读文件");
    expect(codeReadOf(bash("sed -n '1,80p' /data/worktrees/1/1/src/web/components/RouterWorkbench.tsx"), worktrees, changed)).toContain("读代码");
    expect(codeReadOf(bash("cd /repo && git diff main...hub/1-x | head -200"), worktrees, changed)).toContain("读 diff");
  });
  it("看截图、读别处的文件、只看统计不算", () => {
    expect(codeReadOf(read("/data/worktrees/1/1/shots/m.png"), worktrees, changed)).toBeNull();
    expect(codeReadOf(read("/repo/AGENTS.md"), worktrees, changed)).toBeNull();
    expect(codeReadOf(bash("git diff --stat main...hub/1-x"), worktrees, changed)).toBeNull();
  });
});

describe("evidenceOf：看证据", () => {
  it("看截图、看改动名单算；读别的不算", () => {
    expect(evidenceOf(read("/tmp/shots/mobile.png"))).toContain("看截图");
    expect(evidenceOf(bash("git diff --stat main...hub/1-x"))).toContain("改动名单");
    expect(evidenceOf(read("/repo/src/a.ts"))).toBeNull();
    expect(evidenceOf(bash("git diff main"))).toBeNull();
  });
});
