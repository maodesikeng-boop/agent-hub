import { describe, it } from "vitest";

describe("deliverablesOf", () => {
  it.todo("null、非数组、形状不对的元素当作没有，不抛错");
  it.todo("形状对的原样留下，顺序不变");
});

describe("deliverableOfSentFile", () => {
  it.todo("标签为空时用文件名");
  it.todo("标签超过 DELIVERABLE_LABEL_MAX_CHARS 字时截断");
  it.todo("带上来源消息和下标；没有来源时 origin 是 null");
});

describe("mergeDeliverables", () => {
  it.todo("同一个副本只留第一次出现的");
  it.todo("超过 max 个时只留前 max 个");
  it.todo("全是空列表时返回同一个空数组引用");
});

describe("graphDeliverables", () => {
  it.todo("按步骤顺序汇总各步交付物");
  it.todo("跳过的步骤不算");
  it.todo("最多 DELIVERABLES_PER_REPORT_MAX 个");
});

describe("groupDeliverables", () => {
  it.todo("png、mp4、mov 进 media，md、pdf、html 进 documents，组内顺序不变");
  it.todo("同一个列表引用重复调用返回同一个对象");
});

describe("sentFilesOfDeliverables", () => {
  it.todo("换出的 SentFile 的 href 和交付物的 href 一样，状态是 saved");
  it.todo("同一个列表引用重复调用返回同一个数组引用");
});

describe("parseHubFileArg", () => {
  it.todo("`方案=/tmp/x.md` 拆成标签和路径");
  it.todo("只写路径时标签是 null");
  it.todo("路径里有 `=`、前面像路径时整个当路径");
  it.todo("空串或只有标签时抛 RangeError");
});
