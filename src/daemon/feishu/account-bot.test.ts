import { describe, it } from "vitest";

describe("feishuChatOwnerOfDescription", () => {
  it.todo("认出 feishuChatMarker 写进群说明的设备编号和项目经理编号");
  it.todo("没有标记、标记里的设备编号不合法时回 null");
});

describe("routeAccountInbound", () => {
  it.todo("总助单聊回 local");
  it.todo("归属本机的群回 local");
  it.todo("归属别的设备且在线回 forward，离线回 offline");
  it.todo("认不出的群回 ignore");
});

describe("feishuCardkitBudgetShare", () => {
  it.todo("按设备数平分向下取整");
  it.todo("平分后不足 FEISHU_CARDKIT_MIN_SHARE_PER_SECOND 时取下限");
  it.todo("设备数小于 1 时按 1 算");
});

describe("createFeishuOfflineInbox", () => {
  it.todo("按收到的顺序列出一台的暂存");
  it.todo("同一条飞书消息只存一次");
  it.todo("一台满 FEISHU_OFFLINE_INBOX_MAX_PER_DEVICE 条后回 full，不存");
  it.todo("expire 删掉超过 FEISHU_OFFLINE_INBOX_TTL_MS 的，按群返回条数");
});

describe("createFeishuAccountBot", () => {
  it.todo("别的设备的群里的消息经组网转给那台，那台账本里只出现一次");
  it.todo("归属设备离线时立刻在群里回 feishuOfflineNotice，并存进暂存箱");
  it.todo("暂存箱为 null（不暂存）时只回离线提示");
  it.todo("归属设备上线后按顺序送达暂存的消息，带上原来收到的时刻，送达后删掉");
  it.todo("转发失败按离线处理");
  it.todo("卡片点击转给归属设备，拿回它算出的 toast");
  it.todo("归属设备超过 FEISHU_FORWARD_CARD_TIMEOUT_MS 没回时 toast 写“已收到，正在处理”");
  it.todo("归属设备离线时卡片点击回离线 toast，不暂存");
  it.todo("缓存里没有的群调 chatDescription 读标记，读到后缓存");
  it.todo("learnChats 只收广播者自己设备编号的群");
  it.todo("acceptForwarded 把暂存过的消息标上原来的时刻");
});

describe("feishuOfflineNotice / feishuOfflineCardToast", () => {
  it.todo("暂存时说先存着、上线后自动交给项目经理，不暂存时说上线后再发，都带设备名");
  it.todo("卡片 toast 写设备离线、上线后再点");
});
