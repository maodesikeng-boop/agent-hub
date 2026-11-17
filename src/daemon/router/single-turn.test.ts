import { describe, it } from "vitest";

describe("createRouterTurnRunner", () => {
  it.todo("正常结束时返回这一轮顶层 agent 的全部文字和用量，不含子代理的文字");
  it.todo("到 timeoutMs 时打断这一轮，返回 ok: false 和已经收到的文字");
  it.todo("signal 触发时打断这一轮，返回 reason aborted");
  it.todo("起进程失败、写不进会话、进程提前退出时返回 ok: false，不抛错");
  it.todo("不管成败都撤令牌、结束会话、删掉临时启动目录，onSession 返回的收尾函数被调一次");
  it.todo("purpose 为 catalog 的会话启动环境里没有 HUB_TOKEN、HUB_SOCK，系统提示词是写档提示词");
  it.todo("purpose 为 dispatch 的会话和现在的总助轨道 B 一样拿总助提示词和 hub 令牌");
});
