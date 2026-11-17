import { describe, expect, it } from "vitest";
import {
  PROJECT_CATALOG_ALIASES_MAX,
  PROJECT_CATALOG_DETAIL_MAX_CHARS,
  PROJECT_CATALOG_FOCUS_MAX_CHARS,
  PROJECT_CATALOG_MIN_INTERVAL_MS,
  PROJECT_CATALOG_ONE_LINER_MAX_CHARS,
  PROJECT_CATALOG_OPEN_ITEMS_MAX,
  PROJECT_CATALOG_REFRESH_DELTA,
  PROJECT_CATALOG_USER_CHAR_WEIGHT,
} from "./limits.ts";
import {
  catalogCardOf,
  catalogDue,
  changeScore,
  parseCatalogReply,
  renderCatalogDetail,
  type CatalogDueState,
  type ProjectCatalog,
} from "./project-catalog.ts";

const catalog: ProjectCatalog = {
  oneLiner: "把会议录音转成带说话人的文字稿",
  aliases: ["mercury", "语音转文字"],
  focus: "换成本地 Whisper 模型",
  modules: [{ name: "转写", summary: "调用 Whisper 出逐字稿" }],
  decisions: ["只支持中文和英文"],
  openItems: ["说话人分离准确率"],
};

describe("changeScore", () => {
  it("用户的字乘 PROJECT_CATALOG_USER_CHAR_WEIGHT，项目经理的字算 1，两者相加", () => {
    expect(changeScore({ userChars: 100, agentChars: 7 })).toBe(100 * PROJECT_CATALOG_USER_CHAR_WEIGHT + 7);
    expect(changeScore({ userChars: 0, agentChars: 0 })).toBe(0);
  });
});

describe("catalogDue", () => {
  const now = 10 * PROJECT_CATALOG_MIN_INTERVAL_MS;
  const base: CatalogDueState = { neverWritten: false, refreshedAt: now - PROJECT_CATALOG_MIN_INTERVAL_MS, forced: false, nextAttemptAt: null, score: 0 };

  it("还没写成过档案的项目到期（存量老项目和新项目冷启动）", () => {
    expect(catalogDue({ ...base, neverWritten: true, refreshedAt: null }, now)).toBe(true);
  });

  it("退避期内（nowMs < nextAttemptAt）不到期，哪怕还没写成过或带 forced", () => {
    expect(catalogDue({ ...base, neverWritten: true, refreshedAt: null, nextAttemptAt: now + 1 }, now)).toBe(false);
    expect(catalogDue({ ...base, forced: true, nextAttemptAt: now + 1 }, now)).toBe(false);
    expect(catalogDue({ ...base, forced: true, nextAttemptAt: now }, now)).toBe(true);
  });

  it("离上次写成不到 PROJECT_CATALOG_MIN_INTERVAL_MS 不到期，哪怕 forced 或增量很大", () => {
    const recent = { ...base, refreshedAt: now - PROJECT_CATALOG_MIN_INTERVAL_MS + 1 };
    expect(catalogDue({ ...recent, forced: true }, now)).toBe(false);
    expect(catalogDue({ ...recent, score: PROJECT_CATALOG_REFRESH_DELTA * 10 }, now)).toBe(false);
  });

  it("过了最短间隔，forced 时不看增量字数就到期", () => {
    expect(catalogDue({ ...base, forced: true, score: 0 }, now)).toBe(true);
  });

  it("过了最短间隔，加权字数到 PROJECT_CATALOG_REFRESH_DELTA 到期，差一个字不到期", () => {
    expect(catalogDue({ ...base, score: PROJECT_CATALOG_REFRESH_DELTA }, now)).toBe(true);
    expect(catalogDue({ ...base, score: PROJECT_CATALOG_REFRESH_DELTA - 1 }, now)).toBe(false);
  });
});

describe("parseCatalogReply", () => {
  it("回复里只有一个 JSON 对象时取出档案", () => {
    expect(parseCatalogReply(JSON.stringify(catalog))).toEqual(catalog);
  });

  it("JSON 包在 ```json 代码块里、前后有说明文字时也能取出", () => {
    const reply = `好的，这是档案：\n\n\`\`\`json\n${JSON.stringify(catalog, null, 2)}\n\`\`\`\n\n以上，{不是 JSON}`;
    expect(parseCatalogReply(reply)).toEqual(catalog);
  });

  it("有多个 JSON 对象时取最后一个", () => {
    const second = { ...catalog, oneLiner: "第二版" };
    expect(parseCatalogReply(`${JSON.stringify(catalog)}\n改一下：\n${JSON.stringify(second)}`)?.oneLiner).toBe("第二版");
  });

  it("字段缺失、多出字段、类型不对时返回 null", () => {
    const { focus: _focus, ...missing } = catalog;
    expect(parseCatalogReply(JSON.stringify(missing))).toBeNull();
    expect(parseCatalogReply(JSON.stringify({ ...catalog, extra: 1 }))).toBeNull();
    expect(parseCatalogReply(JSON.stringify({ ...catalog, decisions: "一条" }))).toBeNull();
    expect(parseCatalogReply(JSON.stringify({ ...catalog, oneLiner: "  " }))).toBeNull();
  });

  it("字数超上限的字段截到上限、末尾换成“…”；条数超上限的数组只留前几条", () => {
    const long = parseCatalogReply(
      JSON.stringify({
        ...catalog,
        oneLiner: "字".repeat(110),
        focus: "主".repeat(500),
        openItems: Array.from({ length: PROJECT_CATALOG_OPEN_ITEMS_MAX + 3 }, (_, i) => `第 ${i} 件`),
      }),
    )!;
    expect([...long.oneLiner]).toHaveLength(PROJECT_CATALOG_ONE_LINER_MAX_CHARS);
    expect(long.oneLiner.endsWith("…")).toBe(true);
    expect([...long.focus]).toHaveLength(PROJECT_CATALOG_FOCUS_MAX_CHARS);
    expect(long.openItems).toEqual(Array.from({ length: PROJECT_CATALOG_OPEN_ITEMS_MAX }, (_, i) => `第 ${i} 件`));
  });

  it("别名去掉空白和重复的", () => {
    const parsed = parseCatalogReply(
      JSON.stringify({ ...catalog, aliases: ["Fusa", " ", "", "fusa", "agent-hub", ...Array.from({ length: 20 }, (_, i) => `a${i}`)] }),
    )!;
    expect(parsed.aliases.slice(0, 3)).toEqual(["Fusa", "agent-hub", "a0"]);
    expect(parsed.aliases).toHaveLength(PROJECT_CATALOG_ALIASES_MAX);
  });

  it("不是 JSON 时返回 null，不抛错", () => {
    expect(parseCatalogReply("")).toBeNull();
    expect(parseCatalogReply("我没法写档案")).toBeNull();
    expect(parseCatalogReply("{ 坏的 ")).toBeNull();
    expect(parseCatalogReply("[1, 2]")).toBeNull();
  });
});

describe("catalogCardOf", () => {
  it("只带一句话、别名、主线和写成时刻", () => {
    expect(catalogCardOf(catalog, 123)).toEqual({ oneLiner: catalog.oneLiner, aliases: catalog.aliases, focus: catalog.focus, refreshedAt: 123 });
  });
});

describe("renderCatalogDetail", () => {
  const now = Date.UTC(2026, 10, 17, 12);
  const detail = { projectId: 10, projectName: "mercury", description: "会议录音转文字", catalog, refreshedAt: now - 3 * 3_600_000 };

  it("按项目名、用户写的说明、做什么、别名、主线、核心模块、已定的事、悬着的事、写于何时的顺序输出 Markdown", () => {
    const text = renderCatalogDetail(detail, now);
    const order = ["# 项目 #10 mercury", "说明（用户写的）：会议录音转文字", "做什么：", "别名：mercury、语音转文字", "主线：", "## 核心模块", "- 转写：调用 Whisper", "## 已定的事", "## 悬着的事", "3 小时前更新"];
    const positions = order.map((s) => text.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("没有用户写的说明时不出这一行", () => {
    expect(renderCatalogDetail({ ...detail, description: null }, now)).not.toContain("说明");
    expect(renderCatalogDetail({ ...detail, description: "  " }, now)).not.toContain("说明");
  });

  it("输出不超过 PROJECT_CATALOG_DETAIL_MAX_CHARS 个字", () => {
    const huge = { ...catalog, decisions: Array.from({ length: 200 }, () => "决".repeat(160)) };
    expect([...renderCatalogDetail({ ...detail, catalog: huge }, now)].length).toBeLessThanOrEqual(PROJECT_CATALOG_DETAIL_MAX_CHARS);
  });

  it("档案里的换行和控制字符换成空格，不会多出 Markdown 标题", () => {
    const text = renderCatalogDetail({ ...detail, catalog: { ...catalog, focus: "第一行\n# 假标题\u0007结束" } }, now);
    expect(text).toContain("主线：第一行 # 假标题 结束");
    expect(text.split("\n").filter((l) => l.startsWith("#"))).toHaveLength(4);
  });
});
