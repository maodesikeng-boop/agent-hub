import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECORD_DIR } from "./limits.ts";
import { readRoundRecords, reportHtml, roundsIndexMarkdown, writeRoundRecord, type RoundRecord } from "./record.ts";

const tempDirs: string[] = [];
const makeTempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ui-polish-record-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const SHA = "e".repeat(64);

const makeRecord = (id: string, overrides: Partial<RoundRecord> = {}): RoundRecord => ({
  id,
  kind: "review",
  commit: "1a492d8cdeb21e96e3ca5c1af7df2b5c059b7649",
  browser: "chromium 159",
  finishedAt: "2026-11-17T10:00:00.000Z",
  judges: ["agy/gemini-4-carbon", "claude/opus"],
  shots: [
    {
      shotKey: "chat.normal@desktop",
      sha256: SHA,
      byJudge: {
        "agy/gemini-4-carbon": { style: 9, standard: 8, aesthetic: 9, ux: 9 },
        "claude/opus": { style: 10, standard: 8, aesthetic: 9, ux: 8 },
      },
      dimensions: { style: 9, standard: 8, aesthetic: 9, ux: 8 },
      page: 8,
    },
    {
      shotKey: "router.model-picker@desktop",
      sha256: SHA,
      byJudge: {
        "agy/gemini-4-carbon": { style: 9, standard: 9, aesthetic: 10, ux: 9 },
        "claude/opus": { style: 9, standard: 10, aesthetic: 9, ux: 9 },
      },
      dimensions: { style: 9, standard: 9, aesthetic: 9, ux: 9 },
      page: 9,
    },
  ],
  findings: [
    {
      shotKey: "chat.normal@desktop",
      rule: "WCAG 1.4.3",
      severity: "P2",
      box: { x: 0.8, y: 0.49, w: 0.06, h: 0.03 },
      what: "Add note 对比度 4.05:1",
      fix: "加深次要字色",
      by: ["agy/gemini-4-carbon", "claude/opus"],
      counted: true,
    },
  ],
  fixGroups: [
    {
      id: "g1",
      layer: "shared-component",
      title: "加深果冻底次要文字",
      findings: ["chat.normal@desktop#WCAG 1.4.3"],
      commit: "abc12345",
      outcome: { kept: true },
    },
    {
      id: "g2",
      layer: "screen",
      title: "调整卡片内边距",
      findings: ["chat.normal@desktop#U6"],
      commit: "def67890",
      outcome: { kept: false, reason: "引起右栏换行变坏" },
    },
  ],
  pr: "https://github.com/maodesikeng-boop/agent-hub/pull/338",
  next: { action: "fix", below: ["chat.normal@desktop"] },
  calibration: null,
  ...overrides,
});

describe("writeRoundRecord / readRoundRecords", () => {
  it("写下去再读出来内容一样", () => {
    const root = makeTempDir();
    const recB = makeRecord("R02");
    const recA = makeRecord("R01");
    const pathB = writeRoundRecord(root, recB);
    writeRoundRecord(root, recA);
    expect(pathB).toBe(join(root, RECORD_DIR, "rounds", "R02.json"));
    expect(readRoundRecords(root)).toEqual([recB, recA]);
  });

  it("同一个 id 写第二次抛 Error，原来的文件不变", () => {
    const root = makeTempDir();
    const first = makeRecord("R01", { commit: "first-commit" });
    const path = writeRoundRecord(root, first);
    const before = readFileSync(path, "utf8");
    expect(() => writeRoundRecord(root, makeRecord("R01", { commit: "second-commit" }))).toThrow(/R01/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("每次写完总表里多一行", () => {
    const root = makeTempDir();
    const indexPath = join(root, RECORD_DIR, "rounds.md");
    writeRoundRecord(root, makeRecord("R01"));
    const linesAfterOne = readFileSync(indexPath, "utf8").split("\n").filter((l) => l.startsWith("| R"));
    expect(linesAfterOne).toHaveLength(1);
    writeRoundRecord(root, makeRecord("R02"));
    const linesAfterTwo = readFileSync(indexPath, "utf8").split("\n").filter((l) => l.startsWith("| R"));
    expect(linesAfterTwo).toHaveLength(2);
  });

  it("记录文件坏了时读取抛 Error 并说出文件名", () => {
    const root = makeTempDir();
    const roundsDir = join(root, RECORD_DIR, "rounds");
    mkdirSync(roundsDir, { recursive: true });
    writeFileSync(join(roundsDir, "R99.json"), "{broken-json");
    expect(() => readRoundRecords(root)).toThrow(/R99\.json/);
  });
});

describe("roundsIndexMarkdown", () => {
  it("一轮一行，写不达标图数、最低分、中位分、留下和撤回的修改组数", () => {
    const r1 = makeRecord("R01");
    const r2 = makeRecord("R02", {
      shots: [
        { ...r1.shots[0]!, page: 9 },
        { ...r1.shots[1]!, page: 10 },
      ],
      fixGroups: [],
      next: { action: "confirm" },
    });
    const md = roundsIndexMarkdown([r1, r2]);
    const row1 = md.split("\n").find((l) => l.startsWith("| R01 "))!;
    expect(row1).toBeDefined();
    expect(row1).toContain("1");
    expect(row1).toContain("8");
    expect(row1).toContain("8.5");
    expect(row1).toMatch(/留\s*1/);
    expect(row1).toMatch(/撤\s*1/);
  });

  it("最后一节每张图一行，各轮的页面分按轮次排开", () => {
    const r1 = makeRecord("R01");
    const r2 = makeRecord("R02", {
      shots: [
        { ...r1.shots[0]!, page: 9 },
        { ...r1.shots[1]!, page: 10 },
      ],
    });
    const md = roundsIndexMarkdown([r1, r2]);
    const chatRow = md.split("\n").find((l) => l.includes("`chat.normal@desktop`"))!;
    expect(chatRow).toBeDefined();
    expect(chatRow).toMatch(/\|\s*`chat\.normal@desktop`\s*\|\s*8\s*\|\s*9\s*\|/);
  });
});

describe("reportHtml", () => {
  it("每张图有整屏图、每条计分的发现一个框和一行文字、两家的分数", () => {
    const rec = makeRecord("R01", {
      findings: [
        ...makeRecord("R01").findings,
        {
          shotKey: "chat.normal@desktop",
          rule: "A7",
          severity: "P3",
          box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
          what: "仅单家提的吹毛求疵",
          fix: "不用改",
          by: ["claude/opus"],
          counted: false,
        },
      ],
    });
    const html = reportHtml({ record: rec, shotsDir: "/tmp/fusa-ui-polish/R01" });
    expect(html).toContain('src="chat.normal@desktop.png"');
    expect(html).toContain('src="router.model-picker@desktop.png"');
    expect(html).toContain("left: 80%");
    expect(html).toContain("Add note 对比度 4.05:1");
    expect(html).toContain("agy/gemini-4-carbon");
    expect(html).toContain("claude/opus");
  });

  it("给了上一轮时并排放上一轮的图，写出页面分的变化", () => {
    const prev = makeRecord("R00", {
      shots: [
        { ...makeRecord("R00").shots[0]!, page: 6 },
        { ...makeRecord("R00").shots[1]!, page: 9 },
      ],
    });
    const curr = makeRecord("R01");
    const html = reportHtml({
      record: curr,
      shotsDir: "/tmp/fusa-ui-polish/R01",
      previous: { record: prev, shotsDir: "/tmp/fusa-ui-polish/R00" },
    });
    expect(html).toContain('src="../R00/chat.normal@desktop.png"');
    expect(html).toContain("6 → 8");
  });

  it("发现文字里的尖括号被转义", () => {
    const rec = makeRecord("R01", {
      findings: [
        {
          shotKey: "chat.normal@desktop",
          rule: "ui-standard §11",
          severity: "P1",
          box: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
          what: "<script>alert(1)</script> 溢出",
          fix: "把 <div> 改成 grid-cols-1",
          by: ["agy/gemini-4-carbon"],
          counted: true,
        },
      ],
    });
    const html = reportHtml({ record: rec, shotsDir: "/tmp/fusa-ui-polish/R01" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;div&gt;");
  });

  it("还没有分数（judges 为空）时按区域排出一份只有图的总览", () => {
    const unjudged = makeRecord("R00", {
      judges: [],
      findings: [],
      fixGroups: [],
      next: null,
      shots: [
        {
          shotKey: "quota.normal@desktop",
          sha256: SHA,
          byJudge: {},
          dimensions: { style: 0, standard: 0, aesthetic: 0, ux: 0 },
          page: 0,
        },
        {
          shotKey: "shell.loading@desktop",
          sha256: SHA,
          byJudge: {},
          dimensions: { style: 0, standard: 0, aesthetic: 0, ux: 0 },
          page: 0,
        },
      ],
    });
    const html = reportHtml({ record: unjudged, shotsDir: "/tmp/fusa-ui-polish/R00" });
    expect(html).toContain("整页状态");
    expect(html).toContain("额度");
    expect(html.indexOf("整页状态")).toBeLessThan(html.indexOf("额度"));
    expect(html).toContain('src="shell.loading@desktop.png"');
    expect(html).toContain('src="quota.normal@desktop.png"');
  });
});
