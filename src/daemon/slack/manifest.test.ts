import { describe, it } from "vitest";

describe("buildSlackManifest", () => {
  it.todo("开 Socket Mode 和交互、不开令牌轮换、打开 App Home 的消息页");
  it.todo("机器人权限和订阅的事件正好是 SLACK_BOT_SCOPES 和 SLACK_BOT_EVENTS");
  it.todo("机器人显示名带设备名，超长时截到 Slack 允许的长度");
});

describe("slackCreateAppUrl", () => {
  it.todo("返回 https://api.slack.com/apps?new_app=1&manifest_json= 开头的网址，解码后等于清单");
});
