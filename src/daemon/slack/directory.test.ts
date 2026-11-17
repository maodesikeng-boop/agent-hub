import { describe, it } from "vitest";

describe("slackChannelModeOf", () => {
  it.todo("只有主人和机器人 → solo，guestCount 是 0");
  it.todo("多一个人 → shared，guestCount 是 1");
  it.todo("还没认主人时主人也算访客");
});

describe("createSlackDirectory", () => {
  it.todo("第一次查频道模式调 conversations.members 分页取全，之后在 SLACK_MEMBERS_TTL_MS 内不再查");
  it.todo("成员事件实时改已缓存的频道：访客进来变 shared，走了变回 solo");
  it.todo("查成员失败时按 shared 处理，SLACK_MEMBERS_RETRY_MS 后再查");
  it.todo("成员超过 SLACK_CHANNEL_MEMBERS_MAX 时停止翻页，按 shared 处理");
  it.todo("invalidateMembers 后下一次查询重新调 conversations.members");
  it.todo("显示名优先 display_name，没有用 real_name，截到 SLACK_DISPLAY_NAME_MAX_CHARS 字");
  it.todo("显示名缓存最多 SLACK_USER_CACHE_MAX 人；查失败返回用户编号，SLACK_USER_CACHE_RETRY_MS 后再查");
  it.todo("clear 之后所有缓存清空");
});
