import { describe, it } from "vitest";

describe("fileArgsMarkdown", () => {
  it.todo("每个 --file 一行 `[标签](<路径>)`，没有标签用文件名");
  it.todo("路径带空格、括号时 shareLinkedFiles 能认出同一个路径");
  it.todo("没有参数时返回空串");
});

describe("deliverablesFromText", () => {
  it.todo("链接文字成为标签，顺序和正文一致");
  it.todo("没存下副本的链接不算");
  it.todo("超过 max 个时只留前 max 个");
  it.todo("带上消息编号和文件下标；messageId 为 null 时 origin 为 null");
});

describe("stepDeliverablesOfReport", () => {
  it.todo("只认“文件”栏里的链接，“测试”“交棒”栏里的不算");
  it.todo("“文件”栏写“无”或没写时返回空数组");
});
