#!/usr/bin/env node
// 界面打磨循环的命令入口（docs/ui-polish-loop-design.md 第 3.8 节），`pnpm ui:polish <命令>`：
//   inventory                                  打印界面清单（Markdown）
//   shots [--round <id>] [--only <id|区域>…] [--verify]   截全部界面；--verify 截两遍，有一张字节不同就失败
//   calibrate-shots [--round <id>]             截校准用的图：基准图、几张真实界面、每个弄坏各一张
//   brief --round <id> --judge <厂商/模型> --batch <n> [--run <n>]   打印这一批的评委任务说明
//   check-cards --round <id> --judge <厂商/模型>    评委自查：评分卡格式对不对、图齐不齐
//   score --round <id> [--dismissals <文件>]      合分，写这一轮的记录，打印下一步
//   calibration --round <id>                   算校准报告，写记录
//   report --round <id> [--previous <id>]      生成给用户看的 HTML
// 截图和评分卡默认放 ROUND_OUTPUT_DIR/<轮次>/，记录写进仓库的 RECORD_DIR。

/**
 * 后置：返回进程退出码。0 = 做完了；1 = 命令本身失败（界面到不了、两遍不一致、评分卡不合格、校准没过）；2 = 参数不对，用法打到标准错误。
 */
export async function main(argv: readonly string[]): Promise<number> {
  throw new Error("未实现");
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
