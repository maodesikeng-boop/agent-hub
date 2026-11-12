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
/** 反例：把一件事拆成 n 个节点的图（K1 当时那样：带门禁），不先加载手册（T1、L1 必须不过）。 */
const bigGraph = (title: string, keys: string[]) =>
  heredoc(
    `${hub} graph create --title "${title}"`,
    JSON.stringify({ nodes: keys.map((key, i) => ({ key, title: key, ...(key.startsWith("ok") ? { kind: "gate" } : {}), ...(i > 0 ? { deps: [keys[i - 1]] } : {}) })) }),
  );

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
            // 没看日志就打回作者（R4；R5 仅附证据供人工复核），没绿就合（R6），没问就去改 CI（R7），没挂卡（R9、R10）
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
  // ---- 防过度建图（docs/orchestration-skill-design.md 第 8 节）----
  "k1-install": {
    // 正例：一个 Worker 从安装做到冒烟测试；它交回“等你登录”的汇报，转给用户，用户登录后转回给它
    positive: () => ({
      turns: [
        { steps: [{ bash: heredoc(`${hub} worker start --title "装 magpie 并把 Pi 接到 Antigravity"`, "用户要试：装 magpie 和 Antigravity 插件，用户登录后把 Pi 接上并冒烟测试。要用户点的地方写进汇报。") }, { text: "派了一个 Worker 从安装做到冒烟测试。" }] },
        say("装好了，请打开汇报里的链接登录 Google，登录完告诉我。"),
        { steps: [{ bash: heredoc(`${hub} worker send 1`, "用户已登录成功；网关临时用 magpie serve 跑。接着把 Pi 接上并冒烟测试。") }, { text: "转给它接着做。" }] },
        say("接好了：Pi 能用 Antigravity 的 Gemini。"),
      ],
      defaultTurn: say("好的。"),
    }),
    // 反例：当时那样建 5 个节点、3 道门禁的图，派 2 个 Worker，没加载手册（T1、T2、L1）
    negative: () => ({
      turns: [
        {
          steps: [
            { bash: bigGraph("Pi 接入 Antigravity 模型（经 magpie）", ["ok-approve", "setup", "ok-login", "ok-login2", "connect"]) },
            { bash: heredoc(`${hub} worker start --title "安装 magpie 与 Antigravity 插件"`, "装 magpie 和 Antigravity 插件，发起 Google 登录。") },
            { bash: heredoc(`${hub} worker start --title "Pi 接 Antigravity 模型并冒烟测试"`, "把 Pi 接到 magpie 的 Antigravity 模型并冒烟测试。") },
            { text: "建了图，派了两个 Worker。" },
          ],
        },
      ],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
  "k2-local-config": {
    positive: () => ({
      turns: [
        {
          steps: [
            { bash: "magpie visible pi antigravity" },
            { bash: "magpie pi anthropic/claude-opus-5-5" },
            { bash: "magpie pi antigravity/gemini-3.8-flash && magpie pi anthropic/claude-opus-5-5" },
            { bash: `${hub} models --vendor pi --refresh` },
            { text: "改好了：Pi 只显示 Antigravity 的模型，hub 的列表也刷新了。" },
          ],
        },
      ],
      defaultTurn: say("好的。"),
    }),
    // 反例：本机配置也派 Worker、建图（T1、T2、L1），自己一条命令都没跑（E1）
    negative: () => ({
      turns: [{ steps: [{ bash: bigGraph("只给 Pi 显示 Antigravity", ["visible", "refresh"]) }, { bash: heredoc(`${hub} worker start --title "magpie 只给 Pi 显示 Antigravity" --no-worktree`, "跑 magpie visible pi antigravity，再刷新 hub 的模型列表。") }, { text: "派了。" }] }],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
  "k3-merge": {
    positive: () => ({
      turns: [{ steps: [{ bash: "gh pr checks 238" }, { bash: "gh pr merge 238 --merge" }, { text: "检查全绿，已合并 PR 238。" }] }],
      defaultTurn: say("好的。"),
    }),
    // 反例：派 Worker 去合（T2），读完整 diff（A1），不看检查就合（M1）
    negative: () => ({
      turns: [{ steps: [{ bash: "gh pr diff 238" }, { bash: "gh pr merge 238 --merge" }, { bash: heredoc(`${hub} worker start --title "收尾 README 改名" --no-worktree`, "检查 README 改名后有没有漏的。") }, { text: "合了，另派了一个检查。" }] }],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
  "k4-upgrade": {
    positive: () => ({
      turns: [
        { steps: [{ bash: heredoc(`${hub} worker start --title "升级本机的 6 家 Agent CLI" --no-worktree`, "把本机 6 家 Agent CLI 升级到最新，汇报里列出升级前后的版本。") }, { text: "派了一个 Worker 去升级。" }] },
        { steps: [{ bash: `${hub} models --refresh` }, { text: "都升好了，模型列表也刷新了。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    // 反例：六个工具各一个节点、各一个 Worker（T1、T2、L1）
    negative: () => ({
      turns: [
        {
          steps: [
            { bash: bigGraph("升级本机的 6 家 CLI", ["claude", "agy", "codex", "pi", "dsh", "cursor"]) },
            ...["claude", "agy", "codex"].map((tool) => ({ bash: heredoc(`${hub} worker start --title "升级 ${tool}" --no-worktree`, `把本机的 ${tool} 升级到最新。`) })),
            { text: "每家一个 Worker。" },
          ],
        },
      ],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
  "k5-ui-bug": {
    positive: () => ({
      turns: [
        { steps: [{ bash: heredoc(`${hub} worker start --title "果皮轨：验证方案应直接连到用户拍板"`, "用户原话：“验证方案不应该直接连接用户拍版吗”。修果皮轨连线，提 PR，汇报里给截图和检查结果。") }, { text: "派了一个 Worker。" }] },
        { steps: [{ bash: "gh pr checks 295" }, { bash: "gh pr view 295 --json files" }, { text: "检查全绿，改动文件对得上。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    // 反例：纯展示的修复建图、另挂审查（T1、T2、G5），验收读 diff、不看证据（A1、A2）
    negative: () => ({
      turns: [
        {
          steps: [
            { bash: bigGraph("修果皮轨连线", ["impl", "review"]) },
            { bash: heredoc(`${hub} worker start --title "果皮轨连线修复"`, "修果皮轨连线：验证方案不应该直接连接用户拍版。") },
            { bash: heredoc(`${hub} worker start --title "审查果皮轨连线修复"`, "审查果皮轨连线修复的 PR。") },
            { text: "派了实现和审查。" },
          ],
        },
        { steps: [{ bash: "gh pr diff 295" }, { text: "代码我看过了。" }] },
      ],
      defaultTurn: say("好的。"),
    }),
    nothing: () => ({ defaultTurn: say("好的。") }),
  },
};

/** 反例必须不过的检查。 */
export const NEGATIVE_MUST_FAIL: Record<ScenarioId, string[]> = {
  "s3a-tray": ["G5", "G6", "A3", "A1", "A2"],
  "s5a-ci-mirror": ["R4", "R6", "R7", "R9", "R10"],
  "h2-no-diff": ["A1", "A2"],
  "k1-install": ["T1", "T2", "L1"],
  "k2-local-config": ["T1", "T2", "E1", "L1"],
  "k3-merge": ["T2", "M1", "A1"],
  "k4-upgrade": ["T1", "T2", "L1"],
  "k5-ui-bug": ["T1", "T2", "G5", "A1", "A2", "L1"],
};
