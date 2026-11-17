// Slack 应用清单（App Manifest）：权限、订阅的事件、Socket Mode 开关只在这里定义一次。
// 用户点 createAppUrl 打开 Slack 的“从清单创建应用”页面，清单已经填好，点创建、装到工作区、复制两个令牌即可。

/** 机器人令牌要的权限。少一个，PUT /api/slack/credentials 就拒绝并写明缺哪个。 */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "groups:write",
  "groups:read",
  "groups:history",
  "im:history",
  "im:write",
  "users:read",
  "files:read",
  "files:write",
] as const;

/** 订阅的事件。@机器人 从 message.groups 的正文里认（<@机器人编号>），不另订 app_mention，免得同一句话来两遍。 */
export const SLACK_BOT_EVENTS = [
  "message.groups",
  "message.im",
  "member_joined_channel",
  "member_left_channel",
  "group_rename",
  "group_archive",
  "group_unarchive",
] as const;

/** 应用级令牌（xapp-）要的权限：只开 Socket Mode 连接。 */
export const SLACK_APP_TOKEN_SCOPES = ["connections:write"] as const;

/**
 * 后置：返回 Slack 认的清单 JSON：机器人显示名带设备名（同一工作区里多台设备各一个机器人分得清），
 * 开 Socket Mode 和交互、关令牌轮换、打开 App Home 的消息页（主人私聊发绑定码用），权限和事件就是上面三份。
 */
export function buildSlackManifest(deviceName: string): Record<string, unknown> {
  throw new Error("未实现");
}

/** 后置：返回 https://api.slack.com/apps?new_app=1&manifest_json=<编码后的清单>。 */
export function slackCreateAppUrl(manifest: Record<string, unknown>): string {
  throw new Error("未实现");
}
