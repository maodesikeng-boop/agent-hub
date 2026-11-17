import { describe, it } from "vitest";

describe("routeSlackMessage", () => {
  it.todo("单聊里还没认主人、文字是有效绑定码 → bind_owner");
  it.todo("单聊里别的话、已有主人后再发绑定码 → reject，提示去频道里说");
  it.todo("不是 Fusa 建的频道、还没认主人 → ignore");
  it.todo("频道对应的项目经理已归档 → reject");
  it.todo("总助频道里主人说话 → deliver 给总助；访客说话 → reject");
  it.todo("项目经理频道只有主人时每句话都 deliver，origin 的 mode 是 solo");
  it.todo("项目经理频道有访客时，主人和访客的每句话都 deliver，不用 @机器人，origin 的 mode 是 shared，带发言人名字和主客身份");
  it.todo("访客以“/”开头的话 → reject");
  it.todo("访客带的文件不收，droppedFiles 记个数，文字照常 deliver");
  it.todo("发在串里的话不交给 agent：主人 → reject 并提示在频道主聊天流里说，访客 → ignore");
});

describe("routeSlackAction", () => {
  it.todo("访客点拍板按钮、停止按钮、提交弹窗 → reject（只有主人能拍板 / 停止）");
  it.todo("主人点选项 → answer，clientId 由这次点击派生，同一次点击重投 clientId 相同");
  it.todo("主人点“补充说明”或检查点卡“打回” → open_note；提交弹窗 → answer 带 note");
  it.todo("主人点提醒卡 Done → blocker_done；点停止 → stop，目标是这个频道对应的总助或项目经理");
  it.todo("还没认主人 → ignore");
});
