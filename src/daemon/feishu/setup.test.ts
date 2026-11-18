import { describe, it } from "vitest";

// 用假的传输层和假的 registerApp 跑。

describe("FeishuSetupService：扫码接入", () => {
  it.todo("startRegistration 立刻返回 registering，带确认页链接和过期时间");
  it.todo("扫码确认后存凭证、扫码人成为主人、状态到 connecting，不需要绑定码");
  it.todo("再开一次扫码会取消上一次；cancelRegistration 回到原来的状态");
  it.todo("用户拒绝或过期时回到原来的状态，lastError 写原因，原有凭证不动");
});

describe("FeishuSetupService：手动接入", () => {
  it.todo("凭证换不到 tenant_access_token 时抛 FeishuSetupError，原有凭证和连接不动");
  it.todo("验过后状态是 awaiting_owner；绑定码用一次作废，过了 FEISHU_BIND_CODE_TTL_MS 失效");
  it.todo("已有主人时 issueBindCode 抛 FeishuSetupError");
});

describe("FeishuSetupService：设置", () => {
  it.todo("status、startRegistration、saveCredentials 的返回值里搜不到 App Secret");
  it.todo("setChatPolicy 改完后群里那张访客权限卡跟着改；没有这个群抛 FeishuSetupError");
  it.todo("缺必需权限时状态是 needs_permission，missing 列出缺的");
  it.todo("disconnect 删掉凭证文件和四张表；dissolveChats 为 true 时先解散项目群");
});
