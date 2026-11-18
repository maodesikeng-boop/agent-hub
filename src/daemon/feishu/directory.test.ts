import { describe, it } from "vitest";

describe("createFeishuDirectory", () => {
  it.todo("群里除主人外没有别人时 modeOf 是 solo，有别人时是 shared");
  it.todo("发言人不是主人时 modeOf 立刻返回 shared，不发请求");
  it.todo("成员进出事件直接改缓存，下一次 modeOf 不发请求就变");
  it.todo("缓存过了 FEISHU_MEMBERS_TTL_MS 重拉；拉失败返回 null，modeOf 按 shared，FEISHU_MEMBERS_RETRY_MS 内不再重拉");
  it.todo("超过 FEISHU_CHAT_CACHE_MAX 个群时淘汰最久没用的");
  it.todo("markAllStale 后每个群下一次都重拉；forget 和 clear 清掉缓存");
});

describe("createFeishuContextWindows", () => {
  it.todo("超过 FEISHU_CONTEXT_MAX_LINES 行或 FEISHU_CONTEXT_MAX_CHARS 字时丢最早的");
  it.todo("超过 FEISHU_CONTEXT_TTL_MS 的行 peek 不返回");
  it.todo("peek 不清空，clear 清空这个群，clearAll 清空全部");
});
