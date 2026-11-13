import { describe, expect, it } from "vitest";
import { commandMayWriteOutsideScope, scopeAllowsWrite, workerWriteScope } from "./write-scope.ts";

const dataDir = "/Users/u/.agent-hub";
const cwd = "/Users/u/.agent-hub/worktrees/1/2";
const home = "/Users/u";
const scope = { dataDir, protectedRoots: [dataDir], writableDirs: [cwd] };

describe("workerWriteScope", () => {
  it("Worker 在 worktree 里：数据目录里只放行自己的工作目录", () => {
    expect(workerWriteScope({ role: "worker", dataDir, cwd })).toEqual(scope);
    expect(workerWriteScope({ role: "worker", dataDir: `${dataDir}/`, cwd: `${cwd}/` })).toEqual(scope);
  });

  it("Worker 在主文件夹干活（--no-worktree）：数据目录整个不能写，主文件夹本来就在外面", () => {
    expect(workerWriteScope({ role: "worker", dataDir, cwd: "/Users/u/code/app" })).toEqual({
      dataDir,
      protectedRoots: [dataDir],
      writableDirs: [],
    });
  });

  it("工作目录就是数据目录、或包着数据目录时不放行（否则等于整个放开）", () => {
    expect(workerWriteScope({ role: "worker", dataDir, cwd: dataDir })?.writableDirs).toEqual([]);
    expect(workerWriteScope({ role: "worker", dataDir, cwd: home })?.writableDirs).toEqual([]);
  });

  it("项目经理和别的角色没有可写范围", () => {
    expect(workerWriteScope({ role: "pm", dataDir, cwd })).toBeNull();
    expect(workerWriteScope({ role: "assistant", dataDir, cwd })).toBeNull();
  });

  it("跨盘同卷 worktree（protectedRoots 含 C 盘数据目录与 D 盘 .fusa-wt）：只放行本 worktree，禁写同卷别的 worktree 与 C 盘数据目录", () => {
    const winDataDir = "C:\\Users\\alice\\.agent-hub";
    const dWtRoot = "D:\\.fusa-wt\\1a2b3c4d";
    const ownWt = "D:\\.fusa-wt\\1a2b3c4d\\7\\524";
    const otherWt = "D:\\.fusa-wt\\1a2b3c4d\\7\\525";
    const winScope = workerWriteScope({
      role: "worker",
      dataDir: winDataDir,
      protectedRoots: [winDataDir, dWtRoot],
      cwd: ownWt,
    })!;
    expect(winScope).toEqual({
      dataDir: winDataDir,
      protectedRoots: [winDataDir, dWtRoot],
      writableDirs: [ownWt],
    });
    const winHome = "C:\\Users\\alice";
    expect(scopeAllowsWrite(winScope, `${ownWt}\\src\\index.ts`, ownWt, winHome)).toBe(true);
    expect(scopeAllowsWrite(winScope, "d:/project-repo/src/lib.rs", ownWt, winHome)).toBe(true);
    expect(scopeAllowsWrite(winScope, "D:\\.pnpm-store\\v3\\files", ownWt, winHome)).toBe(true);
    expect(scopeAllowsWrite(winScope, `${otherWt}\\src\\index.ts`, ownWt, winHome)).toBe(false);
    expect(scopeAllowsWrite(winScope, `${winDataDir}\\state\\hub.sqlite`, ownWt, winHome)).toBe(false);
    expect(scopeAllowsWrite(winScope, "%USERPROFILE%\\.agent-hub\\state\\ui-token", ownWt, winHome)).toBe(false);
    expect(scopeAllowsWrite(winScope, "$env:USERPROFILE\\.agent-hub\\state\\ui-token", ownWt, winHome)).toBe(false);
    expect(scopeAllowsWrite(winScope, `\\\\?\\${ownWt}\\a.ts`, ownWt, winHome)).toBe(true);
    expect(scopeAllowsWrite(winScope, `\\\\?\\${otherWt}\\a.ts`, ownWt, winHome)).toBe(false);
    expect(scopeAllowsWrite(winScope, "C:evil.txt", ownWt, winHome)).toBe(false);
    expect(scopeAllowsWrite(winScope, `${ownWt}\\a.txt:zone.identifier`, ownWt, winHome)).toBe(false);
    expect(commandMayWriteOutsideScope("cd /d C:\\Users\\alice\\.agent-hub\\state && echo x > a.txt", winScope, ownWt, winHome)).toBe(true);
    expect(commandMayWriteOutsideScope(`cd /d ${ownWt}\\src && echo x > a.txt`, winScope, ownWt, winHome)).toBe(false);
  });
});

describe("scopeAllowsWrite", () => {
  it("数据目录里（含 state/、run/、别的 Worker 的 worktree、新建的目录）都不能写", () => {
    for (const p of [
      dataDir,
      `${dataDir}/shots/a.png`,
      `${dataDir}/state/hub.sqlite`,
      `${dataDir}/state/launch/session-1/agy-rules/.agents/rules/fusa-01.md`,
      `${dataDir}/state/personas/pm-1.md`,
      `${dataDir}/state/pm-memory`,
      `${dataDir}/state/pm-memory/1`,
      `${dataDir}/state/pm-memory/1/MEMORY.md`,
      `${dataDir}/state/pm-memory/1/architecture.md`,
      `${dataDir}/run/bin/hub`,
      `${dataDir}/uploads/1/a.txt`,
      `${dataDir}/worktrees/1/3/src/a.ts`,
      `${dataDir}/worktrees/1/22/a.ts`,
      "~/.agent-hub/shots",
      "$HOME/.agent-hub/x",
      "${HOME}/.agent-hub/x",
    ]) {
      expect(scopeAllowsWrite(scope, p, cwd, home), p).toBe(false);
    }
  });

  it("自己的工作目录、数据目录以外都能写", () => {
    for (const p of [cwd, `${cwd}/src/a.ts`, "src/a.ts", "./node_modules/x", ".codegraph/db", "/tmp/x", "/Users/u/.claude/a", "~/.npm/x", "/Users/u/.agent-hub-other/a"]) {
      expect(scopeAllowsWrite(scope, p, cwd, home), p).toBe(true);
    }
  });

  it("防绕过：相对路径穿越、大小写不同", () => {
    expect(scopeAllowsWrite(scope, "../../../shots", cwd, home)).toBe(false);
    expect(scopeAllowsWrite(scope, "../3/a.ts", cwd, home)).toBe(false);
    expect(scopeAllowsWrite(scope, "/Users/u/.AGENT-HUB/Shots", cwd, home)).toBe(false);
    expect(scopeAllowsWrite(scope, `${cwd}/../2/a.ts`, cwd, home)).toBe(true);
  });
});

describe("commandMayWriteOutsideScope", () => {
  it("往数据目录写的命令算", () => {
    for (const c of [
      `mkdir ${dataDir}/shots`,
      "mkdir -p ~/.agent-hub/shots",
      `echo x > ${dataDir}/state/ui-token`,
      `rm -rf ${dataDir}/state/personas`,
      "cp a.png ../../../shots/",
      'python3 -c "open(\'x\',\'w\')" && mv x ~/.agent-hub/',
    ]) {
      expect(commandMayWriteOutsideScope(c, scope, cwd, home), c).toBe(true);
    }
  });

  it("工作目录在范围外时，不带路径的写命令也算", () => {
    expect(commandMayWriteOutsideScope("touch a.txt", scope, dataDir, home)).toBe(true);
    expect(commandMayWriteOutsideScope("ls", scope, dataDir, home)).toBe(false);
  });

  it("只读命令、写自己的工作目录、写数据目录以外不算", () => {
    for (const c of [
      `cat ${dataDir}/state/personas/pm-1.md`,
      `ls ${dataDir}/uploads`,
      "echo x > a.txt",
      "pnpm install",
      "git commit -m x",
      "echo x > /tmp/a && mkdir -p ~/.cache/x",
      "hub status",
    ]) {
      expect(commandMayWriteOutsideScope(c, scope, cwd, home), c).toBe(false);
    }
  });

  it("防绕过：前面一段是只读命令、cd 换到数据目录里再写（审查找到的两个绕法）", () => {
    for (const c of [
      "ls ~/.agent-hub; find ~/.agent-hub/state -delete",
      "cat ~/.agent-hub/state/x | tee ~/.agent-hub/state/y",
      "cd ~ && cd .agent-hub/state && touch x",
      `cd ${dataDir}/state; rm hub.sqlite`,
      "bash -c 'cd ~ && cd .agent-hub/state && touch x'",
      "(cd ../.. && mkdir shots)",
      "pushd ~/.agent-hub >/dev/null && touch x",
      "cd - && touch x",
      "cd $SOMEWHERE && touch x",
    ]) {
      expect(commandMayWriteOutsideScope(c, scope, cwd, home), c).toBe(true);
    }
  });

  it("项目经理专属记忆目录隔离：普通 Worker（含 worktree 与主文件夹）绝不能写 state/pm-memory", () => {
    const mainWorkerCwd = "/Users/u/code/app";
    const mainScope = workerWriteScope({ role: "worker", dataDir, cwd: mainWorkerCwd })!;
    for (const target of [
      `${dataDir}/state/pm-memory/1/MEMORY.md`,
      `${dataDir}/state/pm-memory/1/topic.md`,
      "~/.agent-hub/state/pm-memory/1/topic.md",
      "../../../state/pm-memory/1/MEMORY.md",
    ]) {
      expect(scopeAllowsWrite(scope, target, cwd, home), `worktree:${target}`).toBe(false);
    }
    expect(scopeAllowsWrite(mainScope, `${dataDir}/state/pm-memory/1/MEMORY.md`, mainWorkerCwd, home)).toBe(false);
    expect(scopeAllowsWrite(mainScope, `${dataDir}/state/pm-memory/1/topic.md`, mainWorkerCwd, home)).toBe(false);

    for (const cmd of [
      `echo hacked > ${dataDir}/state/pm-memory/1/MEMORY.md`,
      `cp secret.md ${dataDir}/state/pm-memory/1/topic.md`,
      "tee ~/.agent-hub/state/pm-memory/1/MEMORY.md",
    ]) {
      expect(commandMayWriteOutsideScope(cmd, scope, cwd, home), `worktree cmd:${cmd}`).toBe(true);
      expect(commandMayWriteOutsideScope(cmd, mainScope, mainWorkerCwd, home), `main cmd:${cmd}`).toBe(true);
    }
    expect(commandMayWriteOutsideScope("rm -rf ../../../state/pm-memory/1", scope, cwd, home)).toBe(true);
    expect(commandMayWriteOutsideScope("rm -rf ../../.agent-hub/state/pm-memory/1", mainScope, mainWorkerCwd, home)).toBe(true);
  });

  it("拆段、跟踪 cd 后，正常的写法不误拦", () => {
    for (const c of [
      "ls ~/.agent-hub; echo x > a.txt",
      "cd src && touch a.ts",
      `cd ${cwd}/src && git add -A && git commit -m x`,
      "cd /tmp && touch x",
      "cd ~ && cd .agent-hub/state && cat hub.sqlite",
      "pnpm test 2>&1 | tail -20",
      "cdk deploy",
    ]) {
      expect(commandMayWriteOutsideScope(c, scope, cwd, home), c).toBe(false);
    }
  });
});
