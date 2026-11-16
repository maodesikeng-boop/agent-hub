// 交付物在四处的显示：对话里的提问卡（AskCard）、右栏 Needs You 和果皮轨门禁卡、总助拍板卡、总助简报（components/Deliverables.tsx）。
import { describe, it } from "vitest";

describe("DeliverableFiles", () => {
  it.todo("md、pdf 显示成一行文件链接，标签是交付物的 label");
  it.todo("png 显示成 96px 高的缩略图，点开预览窗看大图");
  it.todo("mp4 显示成带播放键的缩略图，点开预览窗里是原生播放器");
  it.todo("副本取不到（404）时显示“文件已过期”，不留破图");
  it.todo("列表为空时不渲染任何东西");
  it.todo("别的设备的条目，文件地址走那台设备的 client.url");
});

describe("四处入口", () => {
  it.todo("对话里的提问卡：AskMeta.deliverables 列在卡片正文下面");
  it.todo("对话里的提问卡：正文里写了同一个本机链接时，链接也能点开预览");
  it.todo("右栏 Needs You 的提问行展开后列出交付物");
  it.todo("果皮轨门禁卡列出该步 artifact.deliverables");
  it.todo("总助拍板卡：门禁步骤列出该步交付物，独立待决项列出 router 条目上的");
  it.todo("总助简报：deliverables 列在正文下面，链接行只剩网址、Worker、对话");
  it.todo("老条目（没有 deliverables 字段）照原样显示，不报错");
});
