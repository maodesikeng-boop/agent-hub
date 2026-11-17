// 评委的任务说明（docs/ui-polish-loop-design.md 第 3.3 节）：给评委 Worker 的话只在这一处拼。
// 评委只看图和这份说明，不读代码、不看上一轮的分数。图只用盲测编号（blind.ts），看不出哪张是基准图、哨兵或弄坏的。
import { join } from "node:path";
import { FINDING_TEXT_MAX_CHARS, MAX_FINDINGS_PER_CARD, type ViewportName } from "./limits.ts";
import {
  ATTRIBUTION_RULES,
  DIMENSIONS,
  DIMENSION_TITLES,
  NINE_POINT_BAR,
  PRINCIPLES,
  SCORE_BANDS,
  SEVERITIES,
  SEVERITY_MEANS,
  type ScoreCard,
} from "./rubric.ts";

export interface JudgeBriefInput {
  /** `<厂商>/<模型>`，写进评分卡。 */
  judge: string;
  /** 第几次评这批图（校准时 1 到 CALIBRATION_RUNS，平时是 1）。 */
  run: number;
  /** 基准图和风格说明的绝对路径。 */
  baselineImage: string;
  styleBrief: string;
  /** 这一批要评的图：盲测编号、界面名和视口、评委看的整屏图和局部图的绝对路径、机器量出来的毛病、整屏图的 sha256。 */
  items: ReadonlyArray<{
    id: string;
    title: string;
    viewport: ViewportName;
    focus?: string;
    file: string;
    focusFile?: string;
    sha256: string;
    machineFacts: readonly string[];
  }>;
  /** 评分卡写到哪个目录，一张图一个 `<编号>.json`。 */
  cardsDir: string;
  /** 上一轮被驳回的发现和驳回的理由（同一张图上的）；评委不同意可以再提。 */
  dismissed?: ReadonlyArray<{ id: string; what: string; reason: string }>;
}

function buildSelfCheckCommand(input: JudgeBriefInput): string {
  const normalized = input.cardsDir.replaceAll("\\", "/");
  const match = /\/([A-Z]\d{1,2}(?:-confirm)?)\/cards\/(?:batch-size-(\d+)\/)?[^/]+(?:\/run-(\d+))?\/batch-(\d+)\/?$/.exec(normalized);
  if (match === null) {
    const runArg = input.run === 1 ? "" : ` --run ${input.run}`;
    return `pnpm ui:polish check-cards --round <轮次> --judge ${input.judge}${runArg}`;
  }
  const [, round, batchSize, runInPath, batch] = match;
  const parts = ["pnpm ui:polish check-cards", `--round ${round}`, `--judge ${input.judge}`, `--batch ${batch}`];
  if (batchSize !== undefined) parts.push(`--batch-size ${batchSize}`);
  if (runInPath !== undefined || input.run !== 1) parts.push(`--run ${runInPath ?? input.run}`);
  return parts.join(" ");
}

/**
 * 后置：返回一份完整的任务说明：评什么、四项和每条原则怎么核对、严重度怎么定、评分卡的 JSON 格式和一个例子、
 * 每张图的路径、写完后用哪条命令自查格式。同样的输入返回同样的文字。
 * 文字里不出现“哨兵”“弄坏”“校准”和上一轮的分数。
 */
export function judgeBrief(input: JudgeBriefInput): string {
  const sampleShot = input.items[0];
  const exampleCard: ScoreCard = {
    shot: sampleShot?.id ?? "item-001",
    judge: input.judge,
    run: input.run,
    imageSha256: sampleShot?.sha256 ?? "0".repeat(64),
    findings: [
      {
        rule: "ui-standard §11",
        severity: "P0",
        box: { x: 0.955, y: 0.1, w: 0.035, h: 0.5 },
        what: "每一行最右边的单选圆点被面板右边缘切掉一半",
        fix: "装行的容器改用 grid-cols-1，长标题加 min-w-0 truncate，右侧圆点加 shrink-0",
      },
    ],
    holistic: { style: 7, standard: 3, aesthetic: 5, ux: 4 },
    summary: "面板右边被裁，控件露不全",
  };

  const dismissedByShot = new Map<string, Array<{ what: string; reason: string }>>();
  for (const item of input.dismissed ?? []) {
    const list = dismissedByShot.get(item.id) ?? [];
    list.push({ what: item.what, reason: item.reason });
    dismissedByShot.set(item.id, list);
  }

  const lines: string[] = [
    "# 界面评审任务说明",
    "",
    `你的评委标识：\`${input.judge}\`，评审轮序（run）：\`${input.run}\`。`,
    "",
    "## 硬性纪律",
    "",
    "- **只看图和基准资料**：打开下面列出的基准图、风格说明、`docs/ui-standard.md` 以及待评截图。",
    "- **不读仓库代码、不改仓库文件、不跑截图命令**：不要读取 `src/` 或 `test/` 下的源码，不要打开截图目录里的 `manifest.json`、`blind.json`，也不要修改仓库内任何文件；只把评分卡写进指定的评分卡目录。",
    "- **用眼睛看，不跑脚本找不同**：严禁对截图运行 `ffmpeg`、ImageMagick、Python 像素差分或哈希比对脚本；像设计和美学评委那样直接看整屏图和局部放大图。",
    "- **按证据列发现**：不凭笼统印象打分，每一条发现都必须引用一条明确的规则编号或条款、框出图上的比例坐标、写清看得见的事实和具体改法。引不出规则的意见不要写。",
    "",
    "## 先读基准材料",
    "",
    `1. 基准图：\`${input.baselineImage}\`（只代表产品的风格基因，不是 9 分样板）`,
    `2. 风格说明：\`${input.styleBrief}\``,
    "3. 界面标准：`docs/ui-standard.md`",
    "",
    "## 四项评审维度与可引用规则",
    "",
    ...DIMENSIONS.map((d) => `- **${DIMENSION_TITLES[d]}（\`${d}\`）**`),
    "",
    "每条发现的 `rule` 字段只能填下列格式之一：",
    "- 风格一致（`S1`–`S6`）、美学（`A1`–`A8`）、使用体验（`U1`–`U8`）：填下表中的原则编号。",
    "- 行业标准（`standard`）：填 `ui-standard §<条>`（如 `ui-standard §11`、`ui-standard §12.1`）、`frontend-rules §<1-5>`、`WCAG <条款号>`（如 `WCAG 1.4.3`）、`HIG touch-44`，或确认机器检查事实时填 `machine:<检查名>`。",
    "",
    "| 编号 | 所属维度 | 原则 | 出处 | 在图上怎么核对 |",
    "| --- | --- | --- | --- | --- |",
    ...PRINCIPLES.map((p) => `| \`${p.id}\` | ${DIMENSION_TITLES[p.dimension]} | ${p.title} | ${p.source} | ${p.check} |`),
    "",
    "## 9 分的审美高线",
    "",
    ...NINE_POINT_BAR.map((line) => `- ${line}`),
    "",
    "## 归口规则",
    "",
    ...ATTRIBUTION_RULES.map((line) => `- ${line}`),
    "",
    "## 严重度判法与分档规则",
    "",
    ...SEVERITIES.map((sev) => `- **${sev}**：${SEVERITY_MEANS[sev]}`),
    "",
    "系统会根据你的发现按以下固定分档表自动算出每项分数（你填写的 `holistic` 仅作整体印象对账）：",
    "",
    ...SCORE_BANDS.map((band) => `- **${band.score} 分**：${band.means}`),
    "",
    `限制：每张评分卡最多 ${MAX_FINDINGS_PER_CARD} 条发现（同一根因的多处同类表现合并成一条写），\`what\` 与 \`fix\` 各不超过 ${FINDING_TEXT_MAX_CHARS} 字。没有发现时 \`findings\` 填 \`[]\`。`,
    "",
    "## 评分卡 JSON 格式与示例",
    "",
    `每张图单独写一个 JSON 文件到目录 \`${input.cardsDir}\` 下，文件名为 \`<编号>.json\`，\`shot\` 填这张图的编号（先把目录创建出来）。\`box\` 的 \`x\`、\`y\`、\`w\`、\`h\` 都是占整屏图的 0 到 1 比例（\`w\`、\`h\` 大于 0）。`,
    "",
    "```json",
    JSON.stringify(exampleCard, null, 2),
    "```",
    "",
    `## 本批待评截图（共 ${input.items.length} 张）`,
    "",
  ];

  input.items.forEach((item, index) => {
    const outPath = join(input.cardsDir, `${item.id}.json`);
    lines.push(`### ${index + 1}. \`${item.id}\`（${item.title}，视口 \`${item.viewport}\`）`);
    lines.push(`- 整屏图：\`${item.file}\``);
    if (item.focusFile !== undefined) {
      lines.push(`- 局部 2 倍图：\`${item.focusFile}\`${item.focus ? `（${item.focus}）` : ""}`);
    }
    lines.push(`- \`imageSha256\`：\`${item.sha256}\``);
    lines.push(`- 评分卡写入路径：\`${outPath}\``);
    if (item.machineFacts.length > 0) {
      lines.push("- 页面机器检查量出的客观事实（请在看图核实后照实计入或补充上下游影响）：");
      for (const fact of item.machineFacts) lines.push(`  - ${fact}`);
    } else {
      lines.push("- 页面机器检查：未检出硬指标违规");
    }
    const dismissed = dismissedByShot.get(item.id);
    if (dismissed !== undefined && dismissed.length > 0) {
      lines.push("- 上一轮归因驳回记录（若你看图核对后认为驳回不成立，可在发现里重新提出并说明原因）：");
      for (const d of dismissed) lines.push(`  - 原发现「${d.what}」，驳回理由：${d.reason}`);
    }
    lines.push("");
  });

  lines.push(
    "## 交卷前自查",
    "",
    "全部评分卡写完后，在终端运行下面这条命令自查文件是否齐全、JSON 格式与 `imageSha256` 是否全部合格（退出码为 0 才算完成）：",
    "",
    "```sh",
    buildSelfCheckCommand(input),
    "```",
    "",
  );

  return lines.join("\n");
}
