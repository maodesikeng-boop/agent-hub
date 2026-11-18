import { describe, it } from "vitest";

describe("feishu-secrets.json", () => {
  it.todo("写入后权限是 0600，读回等于写入的");
  it.todo("文件不存在 read 返回 null；形状不对抛错");
  it.todo("remove 后 read 返回 null；不存在时 remove 不报错");
});
