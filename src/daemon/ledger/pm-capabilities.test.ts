import { describe, it } from "vitest";

describe("createLedgerPmCapabilities", () => {
  it.todo("没存过的项目经理三类都是 all，没有单独设置");
  it.todo("patch 后再 get 得到同样的 policy");
  it.todo("开关点开再点回来，库里不留这一项");
  it.todo("改 base 时去掉和新 base 相同的单独设置");
  it.todo("set 超过 PM_CAPABILITY_PATCH_MAX_KEYS 项时拒绝且不改");
  it.todo("单独设置超过 PM_CAPABILITY_OVERRIDES_MAX 项时拒绝且不改");
  it.todo("init 从别的项目经理复制 base 和单独设置");
  it.todo("删除项目经理时它的选择一起删掉");
  it.todo("patch 发 pm.updated");
});
