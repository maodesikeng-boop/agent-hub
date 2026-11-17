import { describe, it } from "vitest";

describe("Slack 令牌文件", () => {
  it.todo("writeSlackSecrets 写出的文件权限是 0600，readSlackSecrets 读回相同内容");
  it.todo("文件不在、内容不是合法 JSON、缺字段时 readSlackSecrets 返回 null");
  it.todo("文件权限比 0600 宽时读的时候改回 0600");
  it.todo("removeSlackSecrets 文件本来就没有时不报错");
  it.todo("slackSecretsShapeError：xoxb- 和 xapp- 前缀都对返回 null，否则写明哪个令牌不对");
});
