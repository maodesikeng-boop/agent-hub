import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComposerSource, FILE_SEARCH_DEBOUNCE_MS, useComposerSuggest } from "./composer-suggest.ts";
import { HUB_COMPOSER_COMMANDS } from "../shared/index.ts";
import { detectComposerTrigger, insertSelection, rankCommands, rankMatches, removeLeadingCommand, splitPath, WORKER_COMMAND } from "./composer-trigger.ts";
import { queryClient } from "./query-client.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("detectComposerTrigger：/ 命令", () => {
  it("整条消息开头的 / 触发，query 是后面打的字", () => {
    expect(detectComposerTrigger("/", 1)).toEqual({ kind: "command", query: "", start: 0, end: 1 });
    expect(detectComposerTrigger("/comp", 5)).toEqual({ kind: "command", query: "comp", start: 0, end: 5 });
  });

  it("消息中间的 / 不触发（hi /co）", () => {
    expect(detectComposerTrigger("hi /co", 6)).toBeNull();
    expect(detectComposerTrigger("第一行\n/co", 7)).toBeNull();
  });

  it("带第二个 / 的是路径，不触发（/usr/bin），光标在第二个 / 前面也不触发", () => {
    expect(detectComposerTrigger("/usr/", 5)).toBeNull();
    expect(detectComposerTrigger("/usr/bin", 8)).toBeNull();
    expect(detectComposerTrigger("/usr/bin", 2)).toBeNull();
    expect(detectComposerTrigger("//", 2)).toBeNull();
  });

  it("命令名后面打了空格就结束了", () => {
    expect(detectComposerTrigger("/compact ", 9)).toBeNull();
    expect(detectComposerTrigger("/compact 参数", 11)).toBeNull();
  });

  it("光标落在命令名中间：替换范围到这个词的末尾", () => {
    expect(detectComposerTrigger("/compact", 3)).toEqual({ kind: "command", query: "co", start: 0, end: 8 });
  });

  it("光标在开头（/ 前面）不触发", () => {
    expect(detectComposerTrigger("/co", 0)).toBeNull();
  });
});

describe("detectComposerTrigger：/hub:worker 的参数（一级一级选厂商、模型、思考程度）", () => {
  const head = "/hub:worker ";
  const at = (text: string) => detectComposerTrigger(text, text.length);

  it("命令名从 shared 的 HUB_COMPOSER_COMMANDS 来", () => {
    expect(WORKER_COMMAND).toBe("hub:worker");
    expect(HUB_COMPOSER_COMMANDS.map((c) => c.name)).toContain(WORKER_COMMAND);
  });

  it("命令名后面打了空格：第 0 级（厂商），已选的为空，query 是正在打的词", () => {
    expect(at(head)).toEqual({ kind: "worker", args: [], query: "", start: 12, end: 12 });
    expect(at(`${head}co`)).toEqual({ kind: "worker", args: [], query: "co", start: 12, end: 14 });
  });

  it("第几级 = 前面已选了几个；第 1 级是模型，第 2 级是思考程度", () => {
    expect(at(`${head}codex `)).toEqual({ kind: "worker", args: ["codex"], query: "", start: 18, end: 18 });
    expect(at(`${head}codex gpt`)).toEqual({ kind: "worker", args: ["codex"], query: "gpt", start: 18, end: 21 });
    expect(at(`${head}codex gpt-5.5 hi`)).toEqual({ kind: "worker", args: ["codex", "gpt-5.5"], query: "hi", start: 26, end: 28 });
  });

  it("三级都选完（后面带空格）就不再弹", () => {
    expect(at(`${head}codex gpt-5.5 high `)).toBeNull();
    expect(at(`${head}codex gpt-5.5 high 帮我修个 bug`)).toBeNull();
  });

  it("光标在半个词里：替换范围到这个词的末尾", () => {
    const text = `${head}codex gpt-5.5`;
    expect(detectComposerTrigger(text, 21)).toEqual({ kind: "worker", args: ["codex"], query: "gpt", start: 18, end: 25 });
  });

  it("Backspace 删到上一级：回到上一级的列表，删掉的那个词变成筛选词", () => {
    expect(at(`${head}codex`)).toEqual({ kind: "worker", args: [], query: "codex", start: 12, end: 17 });
    // 再删到命令名本身：回到命令列表
    expect(at("/hub:worker")).toEqual({ kind: "command", query: "hub:worker", start: 0, end: 11 });
  });

  it("正文里的 /hub:worker 不触发（只认整条消息开头），换行后也不算参数", () => {
    expect(at(`hi ${head}co`)).toBeNull();
    expect(at(`第一行\n${head}co`)).toBeNull();
    expect(at(`${head}codex\n正文`)).toBeNull();
  });

  it("两个空格连着（中间空了一级）不当参数", () => {
    expect(at(`${head} codex`)).toBeNull();
    expect(at(`${head}codex  gpt`)).toBeNull();
  });

  it("名字只是开头像（/hub:workers）不算", () => {
    expect(at("/hub:workers co")).toBeNull();
  });
});

describe("rankMatches", () => {
  const rows = [
    { id: "claude", label: "Claude Code", detail: "" },
    { id: "codex", label: "Codex", detail: "" },
    { id: "agy", label: "Antigravity", detail: "Not signed in" },
  ];
  it("几个名字（id、显示名）里任一开头命中排前，其次包含，最后说明里有", () => {
    const names = (r: (typeof rows)[number]) => [r.id, r.label];
    expect(rankMatches(rows, "c", names, (r) => r.detail).map((r) => r.id)).toEqual(["claude", "codex"]);
    expect(rankMatches(rows, "anti", names, (r) => r.detail).map((r) => r.id)).toEqual(["agy"]);
    expect(rankMatches(rows, "signed", names, (r) => r.detail).map((r) => r.id)).toEqual(["agy"]);
    expect(rankMatches(rows, "", names, (r) => r.detail)).toBe(rows);
  });
});

describe("detectComposerTrigger：@ 文件", () => {
  it("开头的 @ 触发", () => {
    expect(detectComposerTrigger("@", 1)).toEqual({ kind: "file", query: "", start: 0, end: 1 });
    expect(detectComposerTrigger("@src/ma", 7)).toEqual({ kind: "file", query: "src/ma", start: 0, end: 7 });
  });

  it("空白后的 @ 触发（空格、换行）", () => {
    expect(detectComposerTrigger("看 @re", 5)).toEqual({ kind: "file", query: "re", start: 2, end: 5 });
    expect(detectComposerTrigger("看\n@re", 5)).toEqual({ kind: "file", query: "re", start: 2, end: 5 });
  });

  it("词中间的 @ 不触发（a@b.com）", () => {
    expect(detectComposerTrigger("a@b.com", 7)).toBeNull();
    expect(detectComposerTrigger("mail a@", 7)).toBeNull();
  });

  it("命令后面也能 @ 文件", () => {
    expect(detectComposerTrigger("/compact @re", 12)).toEqual({ kind: "file", query: "re", start: 9, end: 12 });
  });

  it("@ 选完后面带空格，不再触发", () => {
    expect(detectComposerTrigger("@README.md ", 11)).toBeNull();
  });

  it("光标在 @ 前面不触发；光标越界按末尾算", () => {
    expect(detectComposerTrigger("@re", 0)).toBeNull();
    expect(detectComposerTrigger("@re", 99)).toEqual({ kind: "file", query: "re", start: 0, end: 3 });
  });
});

describe("insertSelection", () => {
  it("替换这一段，后面补一个空格，光标在空格后", () => {
    expect(insertSelection("/co", { start: 0, end: 3 }, "/compact")).toEqual({ text: "/compact ", cursor: 9 });
    expect(insertSelection("看 @re 这个", { start: 2, end: 5 }, "@README.md")).toEqual({ text: "看 @README.md 这个", cursor: 13 });
  });

  it("后面是文字时也只补一个空格；后面已有空格不会变成两个", () => {
    expect(insertSelection("/co", { start: 0, end: 3 }, "/compact").text).toBe("/compact ");
    expect(insertSelection("@re 然后", { start: 0, end: 3 }, "@a.md").text).toBe("@a.md 然后");
  });

  it("带空格的路径照后台给的原样插入", () => {
    expect(insertSelection("@a", { start: 0, end: 2 }, '@"a b.md"')).toEqual({ text: '@"a b.md" ', cursor: 10 });
  });
});

describe("removeLeadingCommand", () => {
  it("拿掉开头到 end 的整段命令，连同后面一个空格或换行；后面没有就到末尾", () => {
    const text = "/hub:worker claude opus high 修一下";
    expect(removeLeadingCommand(text, text.indexOf(" 修"))).toBe("修一下");
    expect(removeLeadingCommand("/hub:worker claude \n第一行\n第二行", 19)).toBe("第一行\n第二行");
    expect(removeLeadingCommand("/hub:worker claude \n第一行\n第二行", 18)).toBe("第一行\n第二行");
    expect(removeLeadingCommand("/hub:worker claude", 18)).toBe("");
  });
});

describe("rankCommands", () => {
  const cmds = [
    { name: "review", description: "复查代码" },
    { name: "compact", description: "压缩上下文" },
    { name: "context", description: "看上下文用了多少" },
    { name: "init", description: "compact 项目说明" },
  ];

  it("空 query 原样返回", () => {
    expect(rankCommands(cmds, "")).toBe(cmds);
  });

  it("名字开头命中的排前面，其次名字里有，最后说明里有；不区分大小写", () => {
    expect(rankCommands(cmds, "COMP").map((c) => c.name)).toEqual(["compact", "init"]);
    expect(rankCommands(cmds, "co").map((c) => c.name)).toEqual(["compact", "context", "init"]);
    expect(rankCommands(cmds, "ompa").map((c) => c.name)).toEqual(["compact", "init"]);
  });

  it("没有匹配返回空", () => {
    expect(rankCommands(cmds, "zzz")).toEqual([]);
  });
});

describe("splitPath", () => {
  it("文件名和父目录", () => {
    expect(splitPath("src/web/App.tsx")).toEqual({ name: "App.tsx", dir: "src/web" });
    expect(splitPath("README.md")).toEqual({ name: "README.md", dir: "" });
    expect(splitPath("/Users/me/a b.md")).toEqual({ name: "a b.md", dir: "/Users/me" });
  });
});

describe("useComposerSuggest：@ 文件搜索缓存回收", () => {
  it("连续多次不同搜索词触发 @ 文件搜索并卸载后，不在 QueryCache 中残留历史搜索条目", async () => {
    vi.useFakeTimers();
    const source: ComposerSource = {
      commands: async () => [],
      files: async (query) => ({
        entries: Array.from({ length: 50 }, (_, i) => ({
          root: "/repo",
          path: `${query}/${i}.ts`,
          insert: `@${query}/${i}.ts`,
        })),
        truncated: false,
      }),
    };
    const hook = renderHook(
      ({ value }) => useComposerSuggest({ value, cursor: value.length, source, enabled: true, onReplace: () => {} }),
      { initialProps: { value: "@q0" } },
    );
    for (let i = 0; i < 120; i++) {
      hook.rerender({ value: `@q${i}` });
      await act(() => vi.advanceTimersByTimeAsync(FILE_SEARCH_DEBOUNCE_MS + 30));
    }
    expect(hook.result.current.menu?.items[0]?.insert).toBe("@q119/0.ts");
    hook.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(queryClient.getQueryCache().findAll({ queryKey: ["composer-files-search"] })).toHaveLength(0);
  });
});
