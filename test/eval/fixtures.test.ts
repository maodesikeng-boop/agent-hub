// 回放包的守卫（设计第 7 节、任务说明的隐私要求）：总共不超过 5MB、单个文件不超过 500KB；不含本机用户名路径、邮箱（GitHub 公开的
// noreply 地址除外：补丁里的提交人就是它，去掉提交号就对不上了）、令牌。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_REPLAY_MAX_FILE_BYTES, EVAL_REPLAY_MAX_TOTAL_BYTES } from "./limits.ts";
import { REPLAY_DIR } from "./scenarios.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

const all = files(REPLAY_DIR);
const texts = all.filter((f) => !f.endsWith(".png"));

describe("回放包", () => {
  it("大小在上限内", () => {
    const sizes = all.map((f) => ({ f: relative(REPLAY_DIR, f), n: statSync(f).size }));
    expect(sizes.filter((s) => s.n > EVAL_REPLAY_MAX_FILE_BYTES)).toEqual([]);
    expect(sizes.reduce((n, s) => n + s.n, 0)).toBeLessThanOrEqual(EVAL_REPLAY_MAX_TOTAL_BYTES);
  });

  it.each(texts.map((f) => relative(REPLAY_DIR, f)))("%s 没有隐私：本机路径、邮箱、令牌", (rel) => {
    const text = readFileSync(join(REPLAY_DIR, rel), "utf8");
    expect(text).not.toMatch(/\/Users\/[^/\s]+|\/home\/(?!runner\b)[^/\s]+/);
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
    expect(emails.filter((e) => !e.endsWith("@users.noreply.github.com"))).toEqual([]);
    expect(text).not.toMatch(/\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9-]{20,}|github_pat_[A-Za-z0-9_]{20,})/);
  });

  it("截图里没有本机路径", () => {
    for (const f of all.filter((x) => x.endsWith(".png"))) expect(readFileSync(f).toString("latin1")).not.toMatch(/\/Users\/[a-z]/);
  });
});
