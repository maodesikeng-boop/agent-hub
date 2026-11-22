import { describe, it } from "vitest";

describe("parseStampPaths", () => {
  it.todo("读出 REVIEW.md 里“Paths that require a review stamp”一节所有反引号里的 glob，到下一个 ## 为止");
  it.todo("没有这一节或一条 glob 都没有时抛错，门禁失败而不是放行");
  it.todo("主干上真实的 REVIEW.md 能解析出非空列表");
});

describe("matchStampPaths", () => {
  it.todo("* 只匹配一段路径，** 跨目录，跟 REVIEW.md 的 Trigger 同一套语义");
  it.todo("返回命中的文件，顺序跟输入一致");
});

describe("decideGateStatus", () => {
  it.todo("没改高风险路径、文件列表完整：发 success，描述写明不需要审查盖章");
  it.todo("改了高风险路径、还没有审查结论：发 pending，描述点名第一个命中的文件");
  it.todo("改了高风险路径、已有守护进程挂的 success：保持不动（有状态的放行）");
  it.todo("已有审查挂的 failure：保持不动，不管改没改高风险路径");
  it.todo("当前状态是门禁自己发的：按路径重新判");
  it.todo("文件列表到了 PR_FILES_API_MAX 上限：按改了高风险路径处理");
  it.todo("描述不超过 140 字符");
});

describe("main", () => {
  it.todo("--dry-run 只打印决定，不发请求");
  it.todo("缺 GITHUB_REPOSITORY、PR_NUMBER、HEAD_SHA 或 GH_TOKEN 时返回 1");
  it.todo("分页读完 PR 的改动文件，读 HEAD_SHA 上最新的 bellwood/review 状态后按决定发或不发");
});
