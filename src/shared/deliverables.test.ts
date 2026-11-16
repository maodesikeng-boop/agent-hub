import { describe, expect, it } from "vitest";
import {
  deliverableOfSentFile,
  deliverablesOf,
  graphDeliverables,
  groupDeliverables,
  mergeDeliverables,
  parseHubFileArg,
  deliverableOriginOfFile,
  sentFilesOfDeliverables,
  type Deliverable,
} from "./deliverables.ts";
import type { TaskNode } from "./domain.ts";
import { DELIVERABLE_LABEL_MAX_CHARS, DELIVERABLES_PER_REPORT_MAX } from "./limits.ts";
import { sentFileMime, type SentFile } from "./sent-files.ts";

let seq = 0;
function d(name: string, over: Partial<Deliverable> = {}): Deliverable {
  seq += 1;
  return {
    label: name,
    id: seq.toString(16).padStart(16, "0"),
    name,
    mime: sentFileMime(name),
    size: 100,
    href: `/tmp/${name}`,
    origin: null,
    ...over,
  };
}

function saved(name: string, over: Partial<SentFile> = {}): SentFile {
  return { href: `/tmp/${name}`, path: `/tmp/${name}`, id: "00000000000000aa", name, size: 10, mime: sentFileMime(name), status: "saved", mtime: 1, ...over };
}

describe("deliverablesOf", () => {
  it("null、非数组、形状不对的元素当作没有，不抛错", () => {
    expect(deliverablesOf(null)).toEqual([]);
    expect(deliverablesOf(undefined)).toEqual([]);
    expect(deliverablesOf("x")).toEqual([]);
    expect(deliverablesOf({ id: "1" })).toEqual([]);
    const good = d("a.md");
    expect(deliverablesOf([null, 3, { ...good, id: 7 }, { ...good, origin: { messageId: "x", index: 0 } }, good])).toEqual([good]);
  });

  it("形状对的原样留下，顺序不变", () => {
    const list = [d("b.png", { origin: { messageId: 9, index: 1 } }), d("a.md")];
    expect(deliverablesOf(JSON.parse(JSON.stringify(list)))).toEqual(list);
  });
});

describe("deliverableOfSentFile", () => {
  it("标签为空时用文件名", () => {
    expect(deliverableOfSentFile(saved("plan.md"), "  ", null).label).toBe("plan.md");
  });

  it("标签超过 DELIVERABLE_LABEL_MAX_CHARS 字时截断", () => {
    const label = deliverableOfSentFile(saved("plan.md"), "方".repeat(DELIVERABLE_LABEL_MAX_CHARS + 5), null).label;
    expect([...label]).toHaveLength(DELIVERABLE_LABEL_MAX_CHARS);
  });

  it("带上来源消息和下标；没有来源时 origin 是 null", () => {
    const file = saved("a.mp4", { size: 2048 });
    expect(deliverableOfSentFile(file, "录屏", { messageId: 4, index: 2 })).toEqual({
      label: "录屏",
      id: file.id,
      name: "a.mp4",
      mime: "video/mp4",
      size: 2048,
      href: "/tmp/a.mp4",
      origin: { messageId: 4, index: 2 },
    });
    expect(deliverableOfSentFile(file, "录屏", null).origin).toBeNull();
  });
});

describe("mergeDeliverables", () => {
  it("同一个副本只留第一次出现的", () => {
    const a = d("a.md");
    const b = d("b.png");
    expect(mergeDeliverables([[a, b], [{ ...a, label: "又一次" }]], 10)).toEqual([a, b]);
  });

  it("超过 max 个时只留前 max 个", () => {
    const list = [d("1.md"), d("2.md"), d("3.md")];
    expect(mergeDeliverables([list.slice(0, 2), list.slice(2)], 2)).toEqual(list.slice(0, 2));
  });

  it("全是空列表时返回同一个空数组引用", () => {
    expect(mergeDeliverables([[], []], 5)).toBe(mergeDeliverables([], 5));
  });
});

describe("graphDeliverables", () => {
  const node = (sortOrder: number, list: Deliverable[] | undefined, skipped = false): Pick<TaskNode, "artifact" | "sortOrder" | "skipped"> => ({
    sortOrder,
    skipped,
    artifact: list === undefined ? null : { deliverables: list },
  });

  it("按步骤顺序汇总各步交付物", () => {
    const plan = d("plan.md");
    const verdict = d("verdict.md");
    const shot = d("shot.png");
    expect(graphDeliverables([node(2, [verdict, shot]), node(1, [plan]), node(3, undefined)])).toEqual([plan, verdict, shot]);
  });

  it("跳过的步骤不算", () => {
    const plan = d("plan.md");
    expect(graphDeliverables([node(1, [plan]), node(2, [d("x.md")], true)])).toEqual([plan]);
  });

  it("最多 DELIVERABLES_PER_REPORT_MAX 个", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(i, Array.from({ length: 4 }, (_, j) => d(`${i}-${j}.md`))));
    expect(graphDeliverables(nodes)).toHaveLength(DELIVERABLES_PER_REPORT_MAX);
  });
});

describe("groupDeliverables", () => {
  it("png、mp4、mov 进 media，md、pdf、html 进 documents，组内顺序不变", () => {
    const list = [d("plan.md"), d("shot.png"), d("a.pdf"), d("rec.mp4"), d("page.html"), d("b.mov")];
    const groups = groupDeliverables(list);
    expect(groups.documents.map((x) => x.name)).toEqual(["plan.md", "a.pdf", "page.html"]);
    expect(groups.media.map((x) => x.name)).toEqual(["shot.png", "rec.mp4", "b.mov"]);
  });

  it("同一个列表引用重复调用返回同一个对象", () => {
    const list = [d("plan.md")];
    expect(groupDeliverables(list)).toBe(groupDeliverables(list));
    expect(groupDeliverables([...list])).not.toBe(groupDeliverables(list));
  });
});

describe("sentFilesOfDeliverables", () => {
  it("换出的 SentFile 的 href 和交付物的 href 一样，状态是 saved", () => {
    const item = d("plan.md");
    const [file] = sentFilesOfDeliverables([item]);
    expect(file).toMatchObject({ href: item.href, id: item.id, name: item.name, mime: item.mime, size: item.size, status: "saved" });
  });

  it("同一个列表引用重复调用返回同一个数组引用", () => {
    const list = [d("plan.md")];
    expect(sentFilesOfDeliverables(list)).toBe(sentFilesOfDeliverables(list));
  });

  it("换出的文件能查回交付物记的原消息；不是换出来的查不到", () => {
    const [a, b] = sentFilesOfDeliverables([d("plan.md", { origin: { messageId: 7, index: 2 } }), d("rec.mp4")]);
    expect(deliverableOriginOfFile(a!)).toEqual({ messageId: 7, index: 2 });
    expect(deliverableOriginOfFile(b!)).toBeNull();
    expect(deliverableOriginOfFile({ ...a! })).toBeUndefined();
  });
});

describe("parseHubFileArg", () => {
  it("`方案=/tmp/x.md` 拆成标签和路径", () => {
    expect(parseHubFileArg("方案=/tmp/x.md")).toEqual({ label: "方案", path: "/tmp/x.md" });
    expect(parseHubFileArg(" 方案 = C:\\a\\x.md ")).toEqual({ label: "方案", path: "C:\\a\\x.md" });
  });

  it("只写路径时标签是 null", () => {
    expect(parseHubFileArg("/tmp/x.md")).toEqual({ label: null, path: "/tmp/x.md" });
  });

  it("路径里有 `=`、前面像路径时整个当路径", () => {
    expect(parseHubFileArg("/tmp/a=b.md")).toEqual({ label: null, path: "/tmp/a=b.md" });
    expect(parseHubFileArg("C:\\a=b.md")).toEqual({ label: null, path: "C:\\a=b.md" });
    expect(parseHubFileArg("截图=/tmp/a=b.png")).toEqual({ label: "截图", path: "/tmp/a=b.png" });
  });

  it("空串或只有标签时抛 RangeError", () => {
    expect(() => parseHubFileArg("  ")).toThrow(RangeError);
    expect(() => parseHubFileArg("方案=")).toThrow(RangeError);
    expect(() => parseHubFileArg("方案=  ")).toThrow(RangeError);
  });
});
