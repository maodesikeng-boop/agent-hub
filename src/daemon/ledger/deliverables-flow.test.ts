// 交付物从哪来、挂到哪（docs/deliverables-design.md）：Worker 汇报 → 步骤 → 检查点卡 → 总助；hub ask / router report 的 --file。
import { describe, it } from "vitest";

describe("Worker 汇报的“文件”栏", () => {
  it.todo("汇报“文件”栏里的本机文件存成副本，记进该步 artifact.deliverables");
  it.todo("再交一次汇报时，该步交付物换成新汇报的（文件栏为空时保留上一次的）");
  it.todo("confirm 步骤的检查点卡带上该步交付物（AskMeta.deliverables），不再拷一次副本");
});

describe("hub ask --file", () => {
  it.todo("独立提问：副本写进 AskMeta.deliverables 和 meta.files，同一事务写进 router_items.deliverables_json");
  it.todo("带 --node：同时合进该步 artifact.deliverables");
  it.todo("不在可分享的文件夹里的路径：拒绝并说明原因，卡片不挂出来");
  it.todo("超过 HUB_FILE_ARGS_MAX 个时拒绝");
});

describe("hub router report", () => {
  it.todo("--file 存成副本，进 deliverables，不再进 links");
  it.todo("--link 的地址是本机路径时拒绝，提示改用 --file");
});

describe("hub graph finish", () => {
  it.todo("投给总助的简报带整张图的交付物（graphDeliverables），最多 DELIVERABLES_PER_REPORT_MAX 个");
});

describe("快照体积", () => {
  it.todo("全量快照里只有等用户拍板的步骤带 artifact.deliverables，单图详情都带");
  it.todo("一个月数据集加上 10 张各带 DELIVERABLES_PER_CARD_MAX 个交付物的待拍板卡，快照仍不超过 SNAPSHOT_MONTH_MAX_BYTES");
});
