import { describe, it } from "vitest";

describe("changeScore", () => {
  it.todo("用户的字乘 PROJECT_CATALOG_USER_CHAR_WEIGHT，项目经理的字算 1，两者相加");
});

describe("catalogDue", () => {
  it.todo("还没写成过档案的项目到期（存量老项目和新项目冷启动）");
  it.todo("退避期内（nowMs < nextAttemptAt）不到期，哪怕还没写成过或带 forced");
  it.todo("离上次写成不到 PROJECT_CATALOG_MIN_INTERVAL_MS 不到期，哪怕 forced 或增量很大");
  it.todo("过了最短间隔，forced 时不看增量字数就到期");
  it.todo("过了最短间隔，加权字数到 PROJECT_CATALOG_REFRESH_DELTA 到期，差一个字不到期");
});

describe("parseCatalogReply", () => {
  it.todo("回复里只有一个 JSON 对象时取出档案");
  it.todo("JSON 包在 ```json 代码块里、前后有说明文字时也能取出");
  it.todo("有多个 JSON 对象时取最后一个");
  it.todo("字段缺失、多出字段、类型不对时返回 null");
  it.todo("字数超上限的字段截到上限、末尾换成“…”；条数超上限的数组只留前几条");
  it.todo("别名去掉空白和重复的");
  it.todo("不是 JSON 时返回 null，不抛错");
});

describe("catalogCardOf", () => {
  it.todo("只带一句话、别名、主线和写成时刻");
});

describe("renderCatalogDetail", () => {
  it.todo("按项目名、用户写的说明、做什么、别名、主线、核心模块、已定的事、悬着的事、写于何时的顺序输出 Markdown");
  it.todo("没有用户写的说明时不出这一行");
  it.todo("输出不超过 PROJECT_CATALOG_DETAIL_MAX_CHARS 个字");
  it.todo("档案里的换行和控制字符换成空格，不会多出 Markdown 标题");
});
