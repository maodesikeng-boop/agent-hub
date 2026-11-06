import { describe, expect, it } from "vitest";
import { commandMayWriteOutsideScope, scopeAllowsWrite, workerWriteScope } from "./write-scope.ts";

const dataDir = "/Users/u/.agent-hub";
const cwd = "/Users/u/.agent-hub/worktrees/1/2";
const home = "/Users/u";
const scope = { dataDir, writableDirs: [cwd] };

describe("workerWriteScope", () => {
  it("Worker 在 worktree 里：数据目录里只放行自己的工作目录", () => {
    expect(workerWriteScope({ role: "worker", dataDir, cwd })).toEqual(scope);
    expect(workerWriteScope({ role: "worker", dataDir: `${dataDir}/`, cwd: `${cwd}/` })).toEqual(scope);
  });

  it("Worker 在主文件夹干活（--no-worktree）：数据目录整个不能写，主文件夹本来就在外面", () => {
    expect(workerWriteScope({ role: "worker", dataDir, cwd: "/Users/u/code/app" })).toEqual({ dataDir, writableDirs: [] });
  });

  it("工作目录就是数据目录、或包着数据目录时不放行（否则等于整个放开）", () => {
    expect(workerWriteScope({ role: "worker", dataDir, cwd: dataDir })?.writableDirs).toEqual([]);
    expect(workerWriteScope({ role: "worker", dataDir, cwd: home })?.writableDirs).toEqual([]);
  });

  it("项目经理和别的角色没有可写范围", () => {
    expect(workerWriteScope({ role: "pm", dataDir, cwd })).toBeNull();
    expect(workerWriteScope({ role: "assistant", dataDir, cwd })).toBeNull();
  });
});

describe("scopeAllowsWrite", () => {
  it("数据目录里（含 state/、run/、别的 Worker 的 worktree、新建的目录）都不能写", () => {
    for (const p of [
      dataDir,
      `${dataDir}/shots/a.png`,
      `${dataDir}/state/hub.sqlite`,
      `${dataDir}/state/personas/pm-1.md`,
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
});
