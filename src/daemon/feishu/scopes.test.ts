import { describe, it } from "vitest";

describe("飞书应用权限", () => {
  it.todo("feishuAppPreset 的应用名带设备名");
  it.todo("checkFeishuScopes 按 FEISHU_REQUIRED_SCOPES 的顺序列出没授予的必需权限，可选权限不进 missing");
  it.todo("没授予 im:message.group_msg 时 mentionOnly 为 true，授予了为 false");
  it.todo("FEISHU_APP_ADDONS 和 FEISHU_REQUIRED_SCOPES 没有平台默认模板之外却没申请的权限（必需权限都在模板或 addons 里）");
});
