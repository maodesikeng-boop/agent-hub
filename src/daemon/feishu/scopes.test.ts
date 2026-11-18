import { describe, expect, it } from "vitest";
import {
  checkFeishuScopes,
  FEISHU_APP_ADDONS,
  FEISHU_GROUP_MSG_SCOPE,
  FEISHU_OPTIONAL_SCOPES,
  FEISHU_REQUIRED_SCOPES,
  FEISHU_TEMPLATE_SCOPES,
  feishuAppPreset,
} from "./scopes.ts";

describe("飞书应用权限", () => {
  it("feishuAppPreset 的应用名带设备名", () => {
    expect(feishuAppPreset("东京").name).toContain("东京");
    expect(feishuAppPreset("  ").name).not.toContain("·");
  });

  it("checkFeishuScopes 按 FEISHU_REQUIRED_SCOPES 的顺序列出没授予的必需权限，可选权限不进 missing", () => {
    const granted = FEISHU_REQUIRED_SCOPES.filter((_, i) => i % 2 === 0);
    const expected = FEISHU_REQUIRED_SCOPES.filter((_, i) => i % 2 === 1);
    expect(checkFeishuScopes(granted).missing).toEqual(expected);
    expect(checkFeishuScopes(FEISHU_REQUIRED_SCOPES).missing).toEqual([]);
    for (const scope of FEISHU_OPTIONAL_SCOPES) expect(checkFeishuScopes([]).missing).not.toContain(scope);
  });

  it("没授予 im:message.group_msg 时 mentionOnly 为 true，授予了为 false", () => {
    expect(checkFeishuScopes(FEISHU_REQUIRED_SCOPES).mentionOnly).toBe(true);
    expect(checkFeishuScopes([...FEISHU_REQUIRED_SCOPES, FEISHU_GROUP_MSG_SCOPE]).mentionOnly).toBe(false);
  });

  it("FEISHU_APP_ADDONS 和 FEISHU_REQUIRED_SCOPES 没有平台默认模板之外却没申请的权限（必需权限都在模板或 addons 里）", () => {
    const requested = new Set([...FEISHU_TEMPLATE_SCOPES, ...FEISHU_APP_ADDONS.scopes.tenant]);
    for (const scope of [...FEISHU_REQUIRED_SCOPES, ...FEISHU_OPTIONAL_SCOPES]) expect(requested.has(scope), scope).toBe(true);
  });
});
