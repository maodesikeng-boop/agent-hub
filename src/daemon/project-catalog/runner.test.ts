import { describe, it } from "vitest";

describe("createProjectCatalogRunner", () => {
  it.todo("wake 后领活、跑一轮 purpose 为 catalog 的单轮、把取出的档案报给 catalogWritten");
  it.todo("连叫几次 wake 只领一轮，不在调用栈里同步领");
  it.todo("同时在写的不超过 concurrency 份");
  it.todo("到 timeoutMs 打断这一轮并报 timeout");
  it.todo("模型选不出来时报 model_unavailable，不起会话");
  it.todo("回复取不出合格档案时报 invalid_reply");
  it.todo("首次建档（previous 为 null）读说明文件放进输入，增量刷新不读文件");
  it.todo("stop 打断在写的并报 shutdown，之后 wake 不再领活");
  it.todo("busy 在有活在写时为 true");
});

describe("readColdStartFiles", () => {
  it.todo("按 README.md、AGENTS.md、CLAUDE.md 的顺序读存在的文件");
  it.todo("每个文件最多 PROJECT_CATALOG_FILE_MAX_CHARS 个字");
  it.todo("文件夹不存在、文件不可读、是文件夹、软链指到主文件夹外时跳过，不抛错");
});
