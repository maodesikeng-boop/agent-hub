import { describe, it } from "vitest";

describe("SlackSetupService", () => {
  it.todo("没配过时 status 是 unconfigured，返回值里没有任何令牌");
  it.todo("manifest 返回清单和一键创建应用的网址");
  it.todo("saveCredentials：auth.test 不过、缺 SLACK_BOT_SCOPES 里的权限、应用级令牌开不了连接时抛 SlackSetupError，写明原因，原有令牌不动");
  it.todo("saveCredentials 通过后写令牌文件、存工作区，状态变成 connecting 或 awaiting_owner");
  it.todo("换了工作区时旧的主人和频道记录清空");
  it.todo("issueBindCode 发新码后旧码作废；已有主人时抛 SlackSetupError");
  it.todo("consumeBindCode 码对且没过期返回 true 并作废，再用一次返回 false；过了 SLACK_BIND_CODE_TTL_MS 返回 false");
  it.todo("disconnect 删掉令牌文件和三张表；archiveChannels 为 true 时先归档 Fusa 建的频道");
});
