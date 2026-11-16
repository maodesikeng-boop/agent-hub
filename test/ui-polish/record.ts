// 每轮的记录（docs/ui-polish-loop-design.md 第 3.7 节）：进仓库的是每轮一份 JSON 和一张总表；图不进仓库（同一个提交重截出来字节一样，记录里留了提交号和每张图的 sha256）。
// 不变量：一轮的记录写下去就不改；要更正就写下一轮。
import type { CalibrationReport, MergedFinding, NextStep, ShotScore } from "./score.ts";

/** 归因分出来的一组修改：同一个根因的发现一起修、一个提交。 */
export interface FixGroup {
  id: string;
  /** 根因在哪一层，修的顺序也是这个顺序。 */
  layer: "standard" | "shared-component" | "screen";
  title: string;
  /** 这一组要消掉的发现：`<图的 key>#<规则>`。 */
  findings: readonly string[];
  /** 修改的提交号，没修（留到下一轮或列给用户）是 null。 */
  commit: string | null;
  /** 下一次评审后填：留下了还是撤回了，撤回写原因。 */
  outcome: { kept: true } | { kept: false; reason: string } | null;
}

export interface RoundRecord {
  /** `C1`、`C2` 是校准，`R01` 起是评审；确认评审在同一轮后面加 `-confirm`。 */
  id: string;
  kind: "calibration" | "review" | "confirm";
  /** 截图的提交和浏览器版本。 */
  commit: string;
  browser: string;
  /** 完成时间，ISO 8601。 */
  finishedAt: string;
  judges: readonly string[];
  /** 每张图的 sha256 和分数。 */
  shots: ReadonlyArray<ShotScore & { sha256: string }>;
  findings: readonly MergedFinding[];
  /** 这次评审之后定的修改分组（review 才有）。 */
  fixGroups: readonly FixGroup[];
  /** 修改所在的 PR。 */
  pr: string | null;
  next: NextStep | null;
  /** 校准才有。 */
  calibration: CalibrationReport | null;
}

/**
 * 后置：写成 `<repoRoot>/docs/ui-polish/rounds/<id>.json`，并重写总表 `docs/ui-polish/rounds.md`，返回 JSON 的路径。
 * 这个 id 已经有记录抛 Error，不覆盖。
 */
export function writeRoundRecord(repoRoot: string, record: RoundRecord): string {
  throw new Error("未实现");
}

/** 全部记录，按写入的先后。读不出来的文件抛 Error 并说出文件名。 */
export function readRoundRecords(repoRoot: string): RoundRecord[] {
  throw new Error("未实现");
}

/** 总表（Markdown）：一轮一行，写提交、评委、不达标的图数、最低分、中位分、修了几组留了几组、PR；最后一节是每张图各轮的页面分。 */
export function roundsIndexMarkdown(records: readonly RoundRecord[]): string {
  throw new Error("未实现");
}

/**
 * 给用户看的一页（HTML，单文件）：每张图的整屏图、发现的框和文字、两家的分数；给了 previous 时并排放上一轮的图和分数变化。
 * 图用相对路径引 shotsDir 里的文件。
 */
export function reportHtml(input: { record: RoundRecord; shotsDir: string; previous?: { record: RoundRecord; shotsDir: string } }): string {
  throw new Error("未实现");
}
