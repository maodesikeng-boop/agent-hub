import { describe, it } from "vitest";

describe("writeRoundRecord / readRoundRecords", () => {
  it.todo("写下去再读出来内容一样");
  it.todo("同一个 id 写第二次抛 Error，原来的文件不变");
  it.todo("每次写完总表里多一行");
  it.todo("记录文件坏了时读取抛 Error 并说出文件名");
});

describe("roundsIndexMarkdown", () => {
  it.todo("一轮一行，写不达标图数、最低分、中位分、留下和撤回的修改组数");
  it.todo("最后一节每张图一行，各轮的页面分按轮次排开");
});

describe("reportHtml", () => {
  it.todo("每张图有整屏图、每条计分的发现一个框和一行文字、两家的分数");
  it.todo("给了上一轮时并排放上一轮的图，写出页面分的变化");
  it.todo("发现文字里的尖括号被转义");
});
