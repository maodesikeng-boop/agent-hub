import { describe, expect, it } from "vitest";
import { sentFileMime, type SentFile } from "../shared/sent-files.ts";
import { parseWorkerReport, REPORT_END, REPORT_START, type WorkerReport } from "../shared/worker.ts";
import { deliverablesFromText, deliverablesOfFileArgs, fileArgsProblem, stepDeliverablesOfReport } from "./deliverables.ts";

let seq = 0;
function saved(href: string, over: Partial<SentFile> = {}): SentFile {
  seq += 1;
  const name = href.split("/").pop()!;
  return { href, path: href, id: seq.toString(16).padStart(16, "0"), name, size: 10, mime: sentFileMime(name), status: "saved", mtime: 1, ...over };
}

describe("deliverablesFromText", () => {
  it("链接文字成为标签，顺序和正文一致", () => {
    const shot = saved("/tmp/shot.png");
    const plan = saved("/tmp/plan.md");
    const text = "- [方案](/tmp/plan.md)\n- ![桌面截图](/tmp/shot.png)";
    const list = deliverablesFromText(text, [shot, plan], 7, 10);
    expect(list.map((x) => [x.label, x.id])).toEqual([
      ["方案", plan.id],
      ["桌面截图", shot.id],
    ]);
  });

  it("没存下副本的链接不算", () => {
    const missing: SentFile = { ...saved("/tmp/gone.md"), id: null, status: "missing" };
    const plan = saved("/tmp/plan.md");
    expect(deliverablesFromText("[a](/tmp/gone.md) [b](/tmp/plan.md) [c](/tmp/other.md)", [missing, plan], 7, 10).map((x) => x.label)).toEqual(["b"]);
  });

  it("超过 max 个时只留前 max 个", () => {
    const files = [saved("/tmp/1.md"), saved("/tmp/2.md"), saved("/tmp/3.md")];
    expect(deliverablesFromText("[1](/tmp/1.md) [2](/tmp/2.md) [3](/tmp/3.md)", files, 7, 2).map((x) => x.label)).toEqual(["1", "2"]);
  });

  it("带上消息编号和文件下标；messageId 为 null 时 origin 为 null", () => {
    const files = [saved("/tmp/a.md"), saved("/tmp/b.md")];
    expect(deliverablesFromText("[b](/tmp/b.md)", files, 7, 10)[0]!.origin).toEqual({ messageId: 7, index: 1 });
    expect(deliverablesFromText("[b](/tmp/b.md)", files, null, 10)[0]!.origin).toBeNull();
  });
});

describe("stepDeliverablesOfReport", () => {
  const reportOf = (files: string | null): WorkerReport => {
    const text = [
      REPORT_START,
      "状态: 做完了",
      "摘要: 好了",
      "提交: abc",
      "PR: 无",
      "测试: 截图 [旧截图](/tmp/old.png)",
      "偏离: 无",
      "交棒: 看 [交棒](/tmp/handoff.md)",
      ...(files === null ? [] : [`文件: ${files}`]),
      "问题: 无",
      REPORT_END,
    ].join("\n");
    const parsed = parseWorkerReport(text);
    if (parsed.kind !== "ok") throw new Error("没认出汇报");
    return parsed.report;
  };
  const files = [saved("/tmp/old.png"), saved("/tmp/handoff.md"), saved("/tmp/plan.md"), saved("/tmp/rec.mp4")];
  const message = { id: 12, meta: { files } as unknown as Record<string, unknown> };

  it("只认“文件”栏里的链接，“测试”“交棒”栏里的不算", () => {
    const list = stepDeliverablesOfReport(reportOf("\n- [方案](/tmp/plan.md)\n- [录屏](/tmp/rec.mp4)"), message);
    expect(list.map((x) => [x.label, x.origin])).toEqual([
      ["方案", { messageId: 12, index: 2 }],
      ["录屏", { messageId: 12, index: 3 }],
    ]);
  });

  it("“文件”栏写“无”或没写时返回空数组", () => {
    expect(stepDeliverablesOfReport(reportOf("无"), message)).toEqual([]);
    expect(stepDeliverablesOfReport(reportOf(null), message)).toEqual([]);
  });
});

describe("--file 的副本换成交付物", () => {
  it("每个 --file 对上同一位置的副本，标签用 --file 写的，没写用文件名", () => {
    const plan = saved("/tmp/plan.md");
    const shot = saved("/tmp/shot.png");
    const list = deliverablesOfFileArgs([{ label: "方案", path: "/tmp/plan.md" }, { label: null, path: "/tmp/shot.png" }], [plan, shot], 5);
    expect(list.map((x) => [x.label, x.id, x.origin])).toEqual([
      ["方案", plan.id, { messageId: 5, index: 0 }],
      ["shot.png", shot.id, { messageId: 5, index: 1 }],
    ]);
  });

  it("有没存下副本的：说出是哪个文件、为什么", () => {
    const plan = saved("/tmp/plan.md");
    const outside: SentFile = { ...saved("/etc/hosts"), id: null, status: "not_allowed" };
    expect(fileArgsProblem([plan])).toBeNull();
    expect(fileArgsProblem([plan, outside])).toBe("--file /etc/hosts：不在可分享的文件夹里");
  });
});
