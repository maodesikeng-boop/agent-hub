// 原始记录在哪：三家各造一份厂商目录（和本机实际的布局一样），看算出的路径对不对；文件不在就返回 null。
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agyTranscriptPath } from "../../vendors/agy/transcript.ts";
import { claudeProjectDirName, claudeTranscriptPath } from "../../vendors/claude/transcript.ts";
import { codexTranscriptPath } from "../../vendors/codex/transcript.ts";
import { vendorTranscriptPath } from "./transcript.ts";

let home: string;
beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "agent-hub-transcript-")));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function touch(...parts: string[]): string {
  const file = join(...parts);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "");
  return file;
}

describe("claude：<配置目录>/projects/<目录名>/<会话 ID>.jsonl", () => {
  const cwd = "/Users/a.b/.agent-hub/worktrees/1/83";
  const id = "ddfca0eb-1e4f-4c40-ad79-4570b36b7c24";

  it("目录名：非字母数字都换成 -（和本机 ~/.claude/projects 里的一样）", () => {
    expect(claudeProjectDirName(cwd)).toBe("-Users-a-b--agent-hub-worktrees-1-83");
  });

  it("文件在就给路径；不在、会话 ID 为空或不安全都是 null", () => {
    const file = touch(home, ".claude", "projects", "-Users-a-b--agent-hub-worktrees-1-83", `${id}.jsonl`);
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: id, cwd }, { home })).toBe(file);
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: "other", cwd }, { home })).toBeNull();
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: "", cwd }, { home })).toBeNull();
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: "../x", cwd }, { home })).toBeNull();
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: id, cwd: "" }, { home })).toBeNull();
  });

  it("CLAUDE_CONFIG_DIR 换了位置就去那里找", () => {
    const configDir = join(home, "cfg");
    const file = touch(configDir, "projects", "-Users-a-b--agent-hub-worktrees-1-83", `${id}.jsonl`);
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: id, cwd }, { home, env: { CLAUDE_CONFIG_DIR: configDir } })).toBe(file);
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: id, cwd }, { home, env: {} })).toBeNull();
  });

  it("工作目录是软链：claude 用真实路径存，所以也按真实路径找", () => {
    const real = join(home, "real", "proj");
    mkdirSync(real, { recursive: true });
    const link = join(home, "link");
    symlinkSync(real, link);
    const file = touch(home, ".claude", "projects", claudeProjectDirName(real), `${id}.jsonl`);
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: id, cwd: link }, { home })).toBe(file);
  });

  it("目录名超过 200 个字符：前 200 个字符加哈希，找以前 200 个字符开头、里面有这个会话的目录", () => {
    const longCwd = `/${"a".repeat(230)}`;
    const prefix = claudeProjectDirName(longCwd).slice(0, 200);
    const file = touch(home, ".claude", "projects", `${prefix}-h4sh`, `${id}.jsonl`);
    touch(home, ".claude", "projects", `${prefix}-other`, "x.jsonl");
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: id, cwd: longCwd }, { home })).toBe(file);
    expect(claudeTranscriptPath({ vendor: "claude", vendorSessionId: "nope", cwd: longCwd }, { home })).toBeNull();
  });
});

describe("codex：<CODEX_HOME>/sessions/年/月/日/rollout-<时间>-<thread id>.jsonl", () => {
  const id = "01a1aee3-ed5d-70c1-9fc2-755439e37e76";
  const ref = { vendor: "codex", vendorSessionId: id, cwd: "/x" };

  it("按 thread id 在日期目录里找，不靠日期", () => {
    const file = touch(home, ".codex", "sessions", "2026", "11", "06", `rollout-2026-11-06T11-25-35-${id}.jsonl`);
    touch(home, ".codex", "sessions", "2026", "11", "05", "rollout-2026-11-05T01-00-00-aaaaaaaa-0000-0000-0000-000000000000.jsonl");
    expect(codexTranscriptPath(ref, { home })).toBe(file);
  });

  it("压缩过的 .jsonl.zst、归档目录里的也认", () => {
    const zst = touch(home, ".codex", "sessions", "2026", "09", "28", `rollout-2026-09-28T16-21-03-${id}.jsonl.zst`);
    expect(codexTranscriptPath(ref, { home })).toBe(zst);
    rmSync(zst);
    const archived = touch(home, ".codex", "archived_sessions", `rollout-2026-09-09T03-05-05-${id}.jsonl.zst`);
    expect(codexTranscriptPath(ref, { home })).toBe(archived);
  });

  it("thread id 只是别的文件名的一部分、不存在、不安全都是 null；CODEX_HOME 换位置", () => {
    touch(home, ".codex", "sessions", "2026", "11", "06", `rollout-2026-11-06T11-25-35-x${id}.jsonl`);
    expect(codexTranscriptPath(ref, { home })).toBeNull();
    expect(codexTranscriptPath({ ...ref, vendorSessionId: "" }, { home })).toBeNull();
    expect(codexTranscriptPath({ ...ref, vendorSessionId: "a/b" }, { home })).toBeNull();
    const other = join(home, "codex-home");
    const file = touch(other, "sessions", "2026", "11", "06", `rollout-2026-11-06T11-25-35-${id}.jsonl`);
    expect(codexTranscriptPath(ref, { home, env: { CODEX_HOME: other } })).toBe(file);
  });
});

describe("agy：~/.gemini/antigravity-cli/conversations/<conversation id>.db", () => {
  const id = "bb013792-e23c-4282-8fe7-b163c6f0a361";
  const ref = { vendor: "agy", vendorSessionId: id, cwd: "/x" };

  it("文件在就给路径；不在、只有 brain/<id>/ 目录（不是对话）、ID 为空都是 null", () => {
    expect(agyTranscriptPath(ref, { home })).toBeNull();
    mkdirSync(join(home, ".gemini", "antigravity-cli", "brain", id, "scratch"), { recursive: true });
    expect(agyTranscriptPath(ref, { home })).toBeNull();
    const file = touch(home, ".gemini", "antigravity-cli", "conversations", `${id}.db`);
    expect(agyTranscriptPath(ref, { home })).toBe(file);
    expect(agyTranscriptPath({ ...ref, vendorSessionId: "" }, { home })).toBeNull();
  });
});

describe("vendorTranscriptPath：按厂商分发", () => {
  it("三家各走各的；不认识的厂商 null", () => {
    const c = touch(home, ".claude", "projects", "-p", "c1.jsonl");
    const x = touch(home, ".codex", "sessions", "2026", "11", "06", "rollout-2026-11-06T00-00-00-x1.jsonl");
    const a = touch(home, ".gemini", "antigravity-cli", "conversations", "a1.db");
    expect(vendorTranscriptPath({ vendor: "claude", vendorSessionId: "c1", cwd: "/p" }, { home })).toBe(c);
    expect(vendorTranscriptPath({ vendor: "codex", vendorSessionId: "x1", cwd: "/p" }, { home })).toBe(x);
    expect(vendorTranscriptPath({ vendor: "agy", vendorSessionId: "a1", cwd: "/p" }, { home })).toBe(a);
    expect(vendorTranscriptPath({ vendor: "grok", vendorSessionId: "c1", cwd: "/p" }, { home })).toBeNull();
  });
});
