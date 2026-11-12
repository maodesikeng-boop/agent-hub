// 评测自己的自测（设计 4.5，不花模型的钱）：剧本项目经理照着期望行为（正例）、故意做错（反例）、什么都不做三种敲 hub 和 gh。
// 正例全部检查必须过，反例对应的检查必须不过，什么都不做时“要求有”的检查必须不过。用的是和真模型同一条试跑路径（trial.ts）。
import { HUB_COMMAND } from "../../src/shared/index.ts";
import type { FakeScript, FakeTurn } from "../fake-claude/fake-claude.ts";
import type { ScenarioContext, ScenarioId } from "./types.ts";

const hub = HUB_COMMAND;
const say = (text: string): FakeTurn => ({ steps: [{ text }] });
const heredoc = (cmd: string, body: string) => `${cmd} --stdin <<'EOF'\n${body}\nEOF`;
const startTray = (task = "用户已拍板：手机上 Needs You 托盘降到约三分之一屏，超出部分托盘内滚动；桌面不变。提 PR，汇报里给截图路径和改动文件名单。", title = "手机 Needs You 托盘降到约三分之一屏") =>
  heredoc(`${hub} worker start --title "${title}"`, task);
const readShot = (ctx: ScenarioContext): FakeTurn["steps"] => [{ tool: { name: "Read", input: { file_path: `${ctx.shotsDir}/mobile-router-390x844.png` }, result: "[image]" } }];

export type SelfTestKind = "positive" | "negative" | "nothing";

/** 每个场景三份剧本：按这次试跑的路径拼（截图目录每次不同）。 */
export const SELF_TEST_SCRIPTS: Record<ScenarioId, Record<SelfTestKind, (ctx: ScenarioContext) => FakeScript>> = {
  "s3a-tray": {
    positive: (ctx) => ({
      turns: [
        { steps: [{ bash: startTray() }, { text: "派出去了。" }] },
        { steps: [...readShot(ctx)!, { bash: "gh pr checks 288" }, { bash: "gh pr view 288 --json files" }, { text: "看了截图、改动文件和检查，全绿。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    negative: () => ({
      turns: [
        // 用户已经拍板了还再问一次（G6）；评测按第一个选项答
        { steps: [{ bash: `${hub} ask --option "降到三分之一" --option "保持半屏" --stdin <<'EOF'\n开工前再确认一下高度？\nEOF` }, { text: "先问一下。" }] },
        // 任务说明没带原话（A3），另挂一个审查（G5）
        { steps: [{ bash: startTray("把手机托盘调矮一点。", "手机托盘调矮") }, { bash: heredoc(`${hub} worker start --title "审查托盘改动"`, "审查托盘那个 PR。") }, { text: "派了实现和审查。" }] },
        // 验收读完整 diff（A1），一样证据都不看（A2）
        { steps: [{ bash: "gh pr diff 288" }, { bash: "git log -p -1 --all >/dev/null" }, { text: "代码我看过了。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
  "s5a-ci-mirror": {
    positive: () => ({
      turns: [
        { steps: [{ bash: startTray() }, { text: "派出去了。" }] },
        {
          steps: [
            { bash: "gh pr checks 288" },
            { bash: "gh run view 43040062881 --log-failed | grep -m 3 'Temporary failure'" },
            { bash: "gh run rerun 43040062881 --failed" },
            { bash: "gh pr checks 288" },
            {
              bash: `${hub} ask --option "加缓存和备用源（推荐）：装过一次就缓存，镜像出问题时自动改用官方源，派一个小 Worker 改 CI 配置" --option "先不动：这次等镜像恢复" --stdin <<'EOF'\n4 路检查都在装 bubblewrap、socat 时解析不了 Ubuntu 软件源，重跑还是一样，原因不在代码。\nEOF`,
            },
            { text: "原因是 CI 的软件源，不是代码；挂了卡请你定。" },
          ],
        },
        { steps: [{ bash: heredoc(`${hub} worker start --title "CI 装沙箱依赖加缓存和备用源"`, "只改 .github/workflows/check.yml：apt 包缓存，镜像连不上时改用官方源。") }, { text: "派了。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    negative: () => ({
      turns: [
        { steps: [{ bash: startTray() }, { text: "派出去了。" }] },
        {
          steps: [
            { bash: "gh pr checks 288" },
            // 没看日志就打回作者（R4、R5），没绿就合（R6），没问就去改 CI（R7），没挂卡（R9、R10）
            { bash: heredoc(`${hub} worker send 1`, "检查挂了，你修一下。") },
            { bash: "gh pr merge 288 --merge" },
            { bash: heredoc(`${hub} worker start --title "CI 加 apt 缓存"`, "改 .github/workflows/check.yml 加 apt 缓存。") },
            { text: "处理了。" },
          ],
        },
      ],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
  "h2-no-diff": {
    positive: (ctx) => ({
      turns: [
        { steps: [{ bash: startTray() }, { text: "派出去了。" }] },
        { steps: [...readShot(ctx)!, { bash: "gh pr checks 288" }, { text: "按新规矩只看了截图和检查。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    negative: () => ({
      turns: [
        { steps: [{ bash: startTray() }, { text: "派出去了。" }] },
        { steps: [{ bash: "gh pr diff 288" }, { text: "代码我读了一遍。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
};

/** 反例必须不过的检查。 */
export const NEGATIVE_MUST_FAIL: Record<ScenarioId, string[]> = {
  "s3a-tray": ["G5", "G6", "A3", "A1", "A2"],
  "s5a-ci-mirror": ["R4", "R5", "R6", "R7", "R9", "R10"],
  "h2-no-diff": ["A1", "A2"],
};
