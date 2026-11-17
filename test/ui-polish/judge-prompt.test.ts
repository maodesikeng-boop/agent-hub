import { describe, expect, it } from "vitest";
import { judgeBrief, type JudgeBriefInput } from "./judge-prompt.ts";
import { DIMENSION_TITLES, DIMENSIONS, PRINCIPLES, SEVERITIES, SEVERITY_MEANS, parseScoreCard } from "./rubric.ts";
import { SCREEN_INVENTORY, expandShots } from "./screens.ts";

const allShots = expandShots(SCREEN_INVENTORY);
const shotA = allShots.find((s) => s.key === "chat.normal@desktop")!;
const shotB = allShots.find((s) => s.key === "router.model-picker@desktop")!;
const SHA_A = "1".repeat(64);
const SHA_B = "2".repeat(64);

const makeInput = (overrides: Partial<JudgeBriefInput> = {}): JudgeBriefInput => ({
  judge: "agy/gemini-4-carbon",
  run: 1,
  baselineImage: "/repo/docs/ui-polish/baseline/baseline.png",
  styleBrief: "/repo/docs/ui-polish/baseline/style-brief.md",
  shots: [
    {
      shot: shotA,
      file: "/tmp/fusa-ui-polish/R01/chat.normal@desktop.png",
      sha256: SHA_A,
      machineFacts: [],
    },
    {
      shot: shotB,
      file: "/tmp/fusa-ui-polish/R01/router.model-picker@desktop.png",
      focusFile: "/tmp/fusa-ui-polish/R01/router.model-picker@desktop.focus.png",
      sha256: SHA_B,
      machineFacts: ["machine:clipped（P0）：单选圆点超出面板右边 17px"],
    },
  ],
  cardsDir: "/tmp/fusa-ui-polish/R01/cards/agy__gemini-4-carbon/batch-1",
  ...overrides,
});

describe("judgeBrief", () => {
  it("写出四项、PRINCIPLES 的每一条和四种严重度的判法", () => {
    const text = judgeBrief(makeInput());
    for (const dim of DIMENSIONS) {
      expect(text).toContain(DIMENSION_TITLES[dim]);
    }
    for (const p of PRINCIPLES) {
      expect(text).toContain(p.id);
      expect(text).toContain(p.title);
      expect(text).toContain(p.check);
    }
    for (const sev of SEVERITIES) {
      expect(text).toContain(sev);
      expect(text).toContain(SEVERITY_MEANS[sev]);
    }
    expect(text).toContain("只看图");
    expect(text).toContain("不读");
    expect(text).toContain("不改仓库");
  });

  it("写出评分卡的 JSON 格式，例子能通过 parseScoreCard", () => {
    const text = judgeBrief(makeInput());
    const match = /```json\n([\s\S]*?)\n```/.exec(text);
    expect(match).not.toBeNull();
    const parsed = parseScoreCard(match![1]!);
    expect(parsed.ok, parsed.ok ? "" : parsed.reason).toBe(true);
    expect(text).toContain("check-cards");
  });

  it("列出这一批每张图的整屏图、局部图路径和 sha256", () => {
    const text = judgeBrief(makeInput());
    expect(text).toContain("/tmp/fusa-ui-polish/R01/chat.normal@desktop.png");
    expect(text).toContain(SHA_A);
    expect(text).toContain("/tmp/fusa-ui-polish/R01/router.model-picker@desktop.png");
    expect(text).toContain("/tmp/fusa-ui-polish/R01/router.model-picker@desktop.focus.png");
    expect(text).toContain(SHA_B);
  });

  it("机器量出来的毛病作为事实写在对应的图下面", () => {
    const text = judgeBrief(makeInput());
    const idxA = text.indexOf("chat.normal@desktop");
    const idxB = text.indexOf("router.model-picker@desktop");
    const idxFact = text.indexOf("单选圆点超出面板右边 17px");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxFact).toBeGreaterThan(idxB);
  });

  it("不出现“哨兵”“弄坏”“校准”和任何上一轮的分数", () => {
    const mutatedShot = { ...shotA, key: "chat.normal@desktop!clip-right" };
    const text = judgeBrief(
      makeInput({
        run: 2,
        shots: [
          {
            shot: mutatedShot,
            file: "/tmp/fusa-ui-polish/C1/chat.normal@desktop!clip-right.png",
            sha256: SHA_A,
            machineFacts: [],
          },
        ],
      }),
    );
    expect(text).not.toContain("哨兵");
    expect(text).not.toContain("弄坏");
    expect(text).not.toContain("校准");
    expect(text).not.toContain("上一轮分数");
    expect(text).not.toContain("上一轮页面分");
  });

  it("上一轮被驳回的发现和理由写在对应的图下面", () => {
    const text = judgeBrief(
      makeInput({
        dismissed: [
          {
            shotKey: "router.model-picker@desktop",
            what: "顶栏入口带浅灰底",
            reason: "ui-standard §21 已改为无底色，当前底色测量为 rgba(0,0,0,0)",
          },
        ],
      }),
    );
    const idxB = text.indexOf("router.model-picker@desktop");
    const idxDismiss = text.indexOf("ui-standard §21 已改为无底色");
    expect(idxDismiss).toBeGreaterThan(idxB);
    expect(text).toContain("顶栏入口带浅灰底");
  });

  it("同样的输入返回同样的文字", () => {
    const input = makeInput({
      dismissed: [{ shotKey: "chat.normal@desktop", what: "间距略紧", reason: "实测为标准 16px" }],
    });
    expect(judgeBrief(input)).toBe(judgeBrief(input));
  });
});
