import { describe, expect, it, vi } from "vitest";
import type { FeishuChatId, FeishuMessageId, FeishuOpenId } from "../../shared/feishu.ts";
import {
  FEISHU_CHAT_CACHE_MAX,
  FEISHU_CONTEXT_MAX_CHARS,
  FEISHU_CONTEXT_MAX_FILES,
  FEISHU_CONTEXT_MAX_LINES,
  FEISHU_CONTEXT_TTL_MS,
  FEISHU_MEMBERS_RETRY_MS,
  FEISHU_MEMBERS_TTL_MS,
} from "../../shared/limits.ts";
import { createFeishuContextWindows, createFeishuDirectory, type FeishuMember } from "./directory.ts";

const OWNER = "ou_owner" as FeishuOpenId;
const GUEST = "ou_guest" as FeishuOpenId;
const chat = (n: number | string = 1) => `oc_${n}` as FeishuChatId;
const owner: FeishuMember = { openId: OWNER, name: "张三" };
const guest: FeishuMember = { openId: GUEST, name: "李四" };

function setup(initial: Record<string, FeishuMember[]> = {}) {
  const members = new Map(Object.entries(initial));
  const fetch = vi.fn(async (chatId: FeishuChatId) => {
    const got = members.get(chatId);
    if (got === undefined) throw new Error("查不到");
    return got;
  });
  return { dir: createFeishuDirectory(fetch), fetch, members };
}

describe("createFeishuDirectory", () => {
  it("群里除主人外没有别人时 modeOf 是 solo，有别人时是 shared", async () => {
    const { dir } = setup({ oc_1: [owner], oc_2: [owner, guest] });
    expect(await dir.modeOf(chat(1), OWNER, OWNER, 0)).toBe("solo");
    expect(await dir.modeOf(chat(2), OWNER, OWNER, 0)).toBe("shared");
  });

  it("发言人不是主人时 modeOf 立刻返回 shared，不发请求", async () => {
    const { dir, fetch } = setup({ oc_1: [owner] });
    expect(await dir.modeOf(chat(1), OWNER, GUEST, 0)).toBe("shared");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("成员进出事件直接改缓存，下一次 modeOf 不发请求就变", async () => {
    const { dir, fetch } = setup({ oc_1: [owner] });
    expect(await dir.modeOf(chat(1), OWNER, OWNER, 0)).toBe("solo");
    dir.applyJoined(chat(1), [guest], 1);
    expect(await dir.modeOf(chat(1), OWNER, OWNER, 2)).toBe("shared");
    dir.applyLeft(chat(1), [GUEST], 3);
    expect(await dir.modeOf(chat(1), OWNER, OWNER, 4)).toBe("solo");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("缓存过了 FEISHU_MEMBERS_TTL_MS 重拉；拉失败返回 null，modeOf 按 shared，FEISHU_MEMBERS_RETRY_MS 内不再重拉", async () => {
    const { dir, fetch, members } = setup({ oc_1: [owner] });
    await dir.members(chat(1), 0);
    await dir.members(chat(1), FEISHU_MEMBERS_TTL_MS - 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    members.delete("oc_1");
    const t = FEISHU_MEMBERS_TTL_MS;
    expect(await dir.members(chat(1), t)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await dir.modeOf(chat(1), OWNER, OWNER, t + 1)).toBe("shared");
    expect(fetch).toHaveBeenCalledTimes(2);
    members.set("oc_1", [owner]);
    expect(await dir.modeOf(chat(1), OWNER, OWNER, t + FEISHU_MEMBERS_RETRY_MS)).toBe("solo");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("超过 FEISHU_CHAT_CACHE_MAX 个群时淘汰最久没用的", async () => {
    const all = Object.fromEntries(Array.from({ length: FEISHU_CHAT_CACHE_MAX + 1 }, (_, i) => [`oc_${i}`, [owner]]));
    const { dir, fetch } = setup(all);
    for (let i = 0; i <= FEISHU_CHAT_CACHE_MAX; i++) await dir.members(chat(i), 0);
    expect(fetch).toHaveBeenCalledTimes(FEISHU_CHAT_CACHE_MAX + 1);
    await dir.members(chat(FEISHU_CHAT_CACHE_MAX), 1);
    expect(fetch).toHaveBeenCalledTimes(FEISHU_CHAT_CACHE_MAX + 1);
    await dir.members(chat(0), 1);
    expect(fetch).toHaveBeenCalledTimes(FEISHU_CHAT_CACHE_MAX + 2);
  });

  it("markAllStale 后每个群下一次都重拉；forget 和 clear 清掉缓存", async () => {
    const { dir, fetch } = setup({ oc_1: [owner], oc_2: [owner] });
    await dir.members(chat(1), 0);
    await dir.members(chat(2), 0);
    dir.markAllStale();
    await dir.members(chat(1), 1);
    await dir.members(chat(2), 1);
    expect(fetch).toHaveBeenCalledTimes(4);
    dir.forget(chat(1));
    await dir.members(chat(1), 2);
    expect(fetch).toHaveBeenCalledTimes(5);
    dir.clear();
    await dir.members(chat(2), 3);
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(await dir.nameOf(chat(2), OWNER, "无名", 4)).toBe("张三");
    expect(await dir.nameOf(chat(2), GUEST, "无名", 4)).toBe("无名");
  });
});

describe("createFeishuContextWindows", () => {
  const line = (text: string, at = 0) => ({ name: "李四", role: "guest" as const, text, at });

  it("超过 FEISHU_CONTEXT_MAX_LINES 行或 FEISHU_CONTEXT_MAX_CHARS 字时丢最早的", () => {
    const w = createFeishuContextWindows();
    for (let i = 0; i < FEISHU_CONTEXT_MAX_LINES + 2; i++) w.add(chat(), line(`第${i}句`));
    const lines = w.peek(chat(), 0);
    expect(lines).toHaveLength(FEISHU_CONTEXT_MAX_LINES);
    expect(lines[0]!.text).toBe("第2句");
    const big = createFeishuContextWindows();
    const half = "字".repeat(FEISHU_CONTEXT_MAX_CHARS / 2);
    big.add(chat(), line(`A${half}`));
    big.add(chat(), line(`B${half}`));
    expect(big.peek(chat(), 0).map((l) => l.text[0])).toEqual(["B"]);
    big.add(chat(2), line("长".repeat(FEISHU_CONTEXT_MAX_CHARS * 2)));
    expect([...big.peek(chat(2), 0)[0]!.text]).toHaveLength(FEISHU_CONTEXT_MAX_CHARS);
  });

  it("超过 FEISHU_CONTEXT_TTL_MS 的行 peek 不返回", () => {
    const w = createFeishuContextWindows();
    w.add(chat(), line("旧", 0));
    w.add(chat(), line("新", FEISHU_CONTEXT_TTL_MS));
    expect(w.peek(chat(), FEISHU_CONTEXT_TTL_MS + 1).map((l) => l.text)).toEqual(["新"]);
  });

  it("peek 不清空，clear 清空这个群，clearAll 清空全部", () => {
    const w = createFeishuContextWindows();
    w.add(chat(1), line("一"));
    w.add(chat(2), line("二"));
    expect(w.peek(chat(1), 0)).toHaveLength(1);
    expect(w.peek(chat(1), 0)).toHaveLength(1);
    w.clear(chat(1));
    expect(w.peek(chat(1), 0)).toEqual([]);
    expect(w.peek(chat(2), 0)).toHaveLength(1);
    w.clearAll();
    expect(w.peek(chat(2), 0)).toEqual([]);
  });

  describe("没唤醒的气泡里带的文件", () => {
    const pending = (n: number, at = 0) => ({
      messageId: `om_${n}` as FeishuMessageId,
      speaker: OWNER,
      file: { type: "image" as const, fileKey: `img_${n}`, fileName: null },
      at,
    });

    it("和背景一起记，按先后返回；每群最多 FEISHU_CONTEXT_MAX_FILES 个，超过丢最早的", () => {
      const w = createFeishuContextWindows();
      for (let i = 0; i < FEISHU_CONTEXT_MAX_FILES + 2; i++) w.add(chat(), line("（发了文件）"), [pending(i)]);
      const files = w.peekFiles(chat(), 0);
      expect(files).toHaveLength(FEISHU_CONTEXT_MAX_FILES);
      expect(files[0]!.file.fileKey).toBe("img_2");
      expect(files.at(-1)!.file.fileKey).toBe(`img_${FEISHU_CONTEXT_MAX_FILES + 1}`);
      w.add(chat(), line("纯文字"));
      expect(w.peekFiles(chat(), 0)).toHaveLength(FEISHU_CONTEXT_MAX_FILES);
    });

    it("同一条消息的同一个资源重复推送只记一份", () => {
      const w = createFeishuContextWindows();
      w.add(chat(), line("（发了文件）"), [pending(1)]);
      w.add(chat(), line("（发了文件）"), [pending(1)]);
      w.add(chat(), line("（发了文件）"), [pending(2)]);
      expect(w.peekFiles(chat(), 0).map((f) => f.file.fileKey)).toEqual(["img_1", "img_2"]);
    });

    it("dropFiles 只摘掉满足条件的文件，背景和别的文件不动", () => {
      const w = createFeishuContextWindows();
      w.add(chat(1), line("一"), [pending(1), { ...pending(2), speaker: "ou_other" as FeishuOpenId }]);
      w.dropFiles(chat(1), (f) => f.speaker === OWNER);
      expect(w.peekFiles(chat(1), 0).map((f) => f.file.fileKey)).toEqual(["img_2"]);
      expect(w.peek(chat(1), 0)).toHaveLength(1);
      expect(() => w.dropFiles(chat(9), () => true)).not.toThrow();
    });

    it("超过 FEISHU_CONTEXT_TTL_MS 的文件不返回；peekFiles 不清空，clear、clearAll 一起清掉", () => {
      const w = createFeishuContextWindows();
      w.add(chat(1), line("旧", 0), [pending(1, 0)]);
      w.add(chat(1), line("新", FEISHU_CONTEXT_TTL_MS), [pending(2, FEISHU_CONTEXT_TTL_MS)]);
      w.add(chat(2), line("二"), [pending(3)]);
      expect(w.peekFiles(chat(1), FEISHU_CONTEXT_TTL_MS + 1).map((f) => f.file.fileKey)).toEqual(["img_2"]);
      expect(w.peekFiles(chat(1), FEISHU_CONTEXT_TTL_MS + 1)).toHaveLength(1);
      w.clear(chat(1));
      expect(w.peekFiles(chat(1), 0)).toEqual([]);
      expect(w.peekFiles(chat(2), 0)).toHaveLength(1);
      w.clearAll();
      expect(w.peekFiles(chat(2), 0)).toEqual([]);
    });
  });
});
