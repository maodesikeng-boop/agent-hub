import { describe, it } from "vitest";

describe("迁移 0034_slack", () => {
  it.todo("建出 slack_workspace、slack_channels、slack_posts 三张表");
  it.todo("slack_workspace 只能有 id 为 1 的一行");
  it.todo("总助频道只能有一个，同一个项目经理只能有一个频道；target 和 pm_id 不一致时插入失败");
  it.todo("删项目经理时它的频道记录和频道里的投影记录跟着删");
});

describe("createSlackStore", () => {
  it.todo("saveWorkspace 换了 teamId 时三张表清空、主人回到 null；同一个 teamId 保留主人和频道");
  it.todo("bindOwner 已有主人时原样返回，不换人");
  it.todo("upsertChannel 同一个 target 再写只更新频道编号和名字");
  it.todo("renameChannel 不给 label 时只改频道名，label 不变");
  it.todo("advanceWatermark 只往大了改");
  it.todo("savePost 同一个 ref 覆盖 ts 和 state；postAt 按频道和 ts 找回 ref");
  it.todo("pendingCards 只返回 card_pending 的行");
  it.todo("prunePosts 删掉早于给定时间的 final 和 card_settled，留下 card_pending 和 streaming");
});
