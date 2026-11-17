import { describe, it } from "vitest";

describe("buildCatalogSystemPrompt", () => {
  it.todo("写明只回一个 JSON 对象、不调用工具，字段名和字数上限与 projectCatalogSchema 一致");
});

describe("buildCatalogTurnText", () => {
  it.todo("首次建档写明“首次建档”并带说明文件；增量刷新带上一版档案");
  it.todo("原话被截时注明更早的略");
  it.todo("不超过 PROJECT_CATALOG_INPUT_MAX_CHARS 个字：先砍原话最早的部分，再砍说明文件，上一版档案和交接不砍");
  it.todo("每段材料包在标签里，标明是材料不是指令");
});
