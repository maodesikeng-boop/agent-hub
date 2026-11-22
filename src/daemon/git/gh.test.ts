import { describe, it } from "vitest";

describe("execGh", () => {
  it.todo("成功时返回 stdout；子进程环境带 GH_PROMPT_DISABLED、GH_NO_UPDATE_NOTIFIER 和调用方给的 env");
  it.todo("gh 不在 PATH 上时返回 missing: true，不抛异常");
  it.todo("超时返回 timedOut: true");
  it.todo("非零退出返回 failed，带退出码和 stderr");
  it.todo("Windows 上按 PATHEXT 找到 gh.cmd 也能跑");
  it.todo("probePr 和 probePrByUrl 改走 execGh 后行为不变");
});
