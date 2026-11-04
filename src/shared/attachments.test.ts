import { describe, expect, it } from "vitest";
import { agentTextOf, attachmentsOf, isImageMime, mimeOfFileName, uploadUrl, type Attachment } from "./attachments.ts";

const photo: Attachment = { id: "a1b2c3d4e5f60718", name: "屏幕截图.png", path: "/data/uploads/a1b2c3d4e5f60718/屏幕截图.png", size: 2048, mime: "image/png" };
const doc: Attachment = { id: "0011223344556677", name: "报告 v2.pdf", path: "/data/uploads/0011223344556677/报告 v2.pdf", size: 9, mime: "application/pdf" };

describe("附件：读 meta", () => {
  it("没有附件字段的老消息、meta 是 null：空列表", () => {
    expect(attachmentsOf({ meta: null })).toEqual([]);
    expect(attachmentsOf({ meta: {} })).toEqual([]);
    expect(attachmentsOf({ meta: { toolUseId: "t1", name: "Bash", input: {} } })).toEqual([]);
  });

  it("读出写进去的附件", () => {
    expect(attachmentsOf({ meta: { attachments: [photo, doc] } })).toEqual([photo, doc]);
  });

  it("形状不对的元素跳过，不抛错（库里的旧数据、手改的数据）", () => {
    const meta = { attachments: [photo, null, "x", { id: 1 }, { ...doc, size: "big" }, { ...doc, name: "" }] };
    expect(attachmentsOf({ meta })).toEqual([photo]);
    expect(attachmentsOf({ meta: { attachments: "oops" } })).toEqual([]);
  });
});

describe("附件：发给 agent 的正文", () => {
  it("没有附件：原文", () => {
    expect(agentTextOf({ text: "你好", meta: null })).toBe("你好");
  });

  it("有附件：原文后面列出每个文件的完整绝对路径", () => {
    const text = agentTextOf({ text: "看看这两个", meta: { attachments: [photo, doc] } });
    expect(text.startsWith("看看这两个\n\n")).toBe(true);
    expect(text).toContain(`- \`${photo.path}\``);
    expect(text).toContain(`- \`${doc.path}\``);
  });

  it("路径用反引号括起来，划清边界（名字里有空格、结尾有标点也不会读错）；名字里自己带反引号时，外面的反引号更长", () => {
    const odd: Attachment = { ...doc, name: "a`b.txt", path: "/d/0011223344556677/a`b.txt" };
    const text = agentTextOf({ text: "", meta: { attachments: [odd] } });
    expect(text).toContain("- ``/d/0011223344556677/a`b.txt``");
    const wild: Attachment = { ...doc, name: "x``y", path: "/d/0011223344556677/x``y" };
    expect(agentTextOf({ text: "", meta: { attachments: [wild] } })).toContain("- ```/d/0011223344556677/x``y```");
  });

  it("只有文件没有文字：正文就是文件清单，没有多余的空行开头", () => {
    const text = agentTextOf({ text: "", meta: { attachments: [photo] } });
    expect(text.startsWith("\n")).toBe(false);
    expect(text).toContain(photo.path);
  });
});

describe("附件：文件类型和地址", () => {
  it("按扩展名认图片，不信客户端报的类型；svg 不算图片（能带脚本）", () => {
    expect(mimeOfFileName("a.PNG")).toBe("image/png");
    expect(mimeOfFileName("a.jpeg")).toBe("image/jpeg");
    expect(mimeOfFileName("a.webp")).toBe("image/webp");
    expect(mimeOfFileName("a.svg")).toBe("application/octet-stream");
    expect(mimeOfFileName("没有扩展名")).toBe("application/octet-stream");
    expect(isImageMime("image/png")).toBe(true);
    expect(isImageMime("application/pdf")).toBe(false);
  });

  it("缩略图地址：编号和文件名分开编码", () => {
    expect(uploadUrl(photo)).toBe(`/api/uploads/${photo.id}/${encodeURIComponent("屏幕截图.png")}`);
    expect(uploadUrl(doc)).toContain("%20");
  });
});
