// 评委的任务说明（docs/ui-polish-loop-design.md 第 3.3 节）：给评委 Worker 的话只在这一处拼。
// 评委只看图和这份说明，不读代码、不看上一轮的分数、不知道哪些图是哨兵或弄坏的。
import type { Shot } from "./screens.ts";

export interface JudgeBriefInput {
  /** `<厂商>/<模型>`，写进评分卡。 */
  judge: string;
  /** 第几次评这批图（校准时 1 到 CALIBRATION_RUNS，平时是 1）。 */
  run: number;
  /** 基准图和风格说明的绝对路径。 */
  baselineImage: string;
  styleBrief: string;
  /** 这一批要评的图：整屏图、局部图的绝对路径，机器量出来的毛病，整屏图的 sha256。 */
  shots: ReadonlyArray<{
    shot: Shot;
    file: string;
    focusFile?: string;
    sha256: string;
    machineFacts: readonly string[];
  }>;
  /** 评分卡写到哪个目录，一张图一个 `<key>.json`。 */
  cardsDir: string;
  /** 上一轮被驳回的发现和驳回的理由（同一张图上的）；评委不同意可以再提。 */
  dismissed?: ReadonlyArray<{ shotKey: string; what: string; reason: string }>;
}

/**
 * 后置：返回一份完整的任务说明：评什么、四项和每条原则怎么核对、严重度怎么定、评分卡的 JSON 格式和一个例子、
 * 每张图的路径、写完后用哪条命令自查格式。同样的输入返回同样的文字。
 * 文字里不出现“哨兵”“弄坏”“校准”和上一轮的分数。
 */
export function judgeBrief(input: JudgeBriefInput): string {
  throw new Error("未实现");
}
