import { HANDOVER_RECENT_CHARS } from "../../shared/limits.ts";
import { HUB_COMMAND } from "../../shared/names.ts";
import { isAgentVendor, vendorLabel, vendorSpec } from "../../shared/vendors.ts";

const SEARCH_COMMANDS = `\`${HUB_COMMAND} worker search\`、\`${HUB_COMMAND} worker show --task / --report\``;

const transcriptLine = (path: string | null) =>
  path === null ? "上一个会话的原始记录（厂商自己存的完整原文；这次没找到文件，翻不了）" : `上一个会话的原始记录：${path}（要查原话可以去翻）`;

export function handoverRequestText(options: {
  auto: boolean;
  transcriptPath: string | null;
  forked: boolean;
  fromVendor?: string;
  toVendor?: string | null;
}): string {
  const why = options.auto
    ? "你的对话太长了，系统要自动给你换一个新会话——这是系统定的，不是用户要换；用户看不到这里，也不知道换会话的事。"
    : "用户要给你换一个新会话（现在的上下文太长了）。";
  const opening = options.forked
    ? `【系统】这是从你的会话复制出来的一份，只用来写交接：${why}用户看不到这里；这里没有 hub 凭证，不要调用工具，直接把交接写成这一轮的回复。`
    : `【系统】${why}这一轮请写一份交接，直接写成这一轮的回复。`;
  const only = options.forked ? "这一轮只写交接：不调用工具、不回复用户、不派活。" : "这一轮只写交接：不回复用户、不派活、不做别的事。";
  const onlyTools = options.fromVendor !== undefined && isAgentVendor(options.fromVendor) ? vendorSpec(options.fromVendor).prompt.vendorOnlyTools : undefined;
  const vendorNote =
    options.toVendor != null && options.fromVendor !== undefined && options.toVendor !== options.fromVendor
      ? `\n新会话换成 ${vendorLabel(options.toVendor)}（${options.toVendor}），别写只有 ${vendorLabel(options.fromVendor)}（${options.fromVendor}）才有的工具用法${onlyTools === undefined ? "" : `（比如 ${onlyTools}）`}，写成要做的事和现在的状态。`
      : "";
  return `${opening}

这份交接会替换掉你现在的全部上下文。新会话手里只有：
- 最新的系统提示词和性格设定；
- 你这个会话加载过的技能索引（系统自动带上路径和简介，新会话按需读取，交接里不用写）；
- 这份交接；
- 交接之前约 ${HANDOVER_RECENT_CHARS / 10_000} 万字你和用户的原话（写交接期间又聊的也会全部带上）；
- 能搜的账本：${SEARCH_COMMANDS}（派过的活、Worker 的汇报都在里面）；
- ${transcriptLine(options.transcriptPath)}。
交接里漏掉的，新会话连去找都不会知道要去找。所以要写的是理解，不是流水账：用户想做成什么、为什么，定了什么，试过和否掉了什么，做到哪了，下一步是什么。${vendorNote}

按下面几节写：
1. 用户要做成什么、为什么：用户明确提过的每个要求和背后的用意，写细。
2. 定下的事：做法、约束、分工；用户纠正过的做法单独写清楚（原来怎么做、用户要怎么做）。
3. 试过和否掉的：试过什么办法、为什么不行，免得新会话再走一遍。
4. 进行中的 Worker 与未完事项（如有分支或 PR 一并注明）：编号、在做什么、到哪一步、在等什么。
5. 用户这段时间说过的话：要点逐条列全，规矩、约束类的保留原话。
6. 下一步：写清楚最后在做什么、做到哪了、接下来要做什么。原话会另外带给新会话，这里不用抄。

你这个会话开头要是带着上一份交接：它的第 1 节原样带过来，再补上之后新的。
控制在 2000 字左右。做过的细节（任务说明、汇报全文、命令输出）账本里搜得到，不往交接里抄，写一句去哪搜就行。
${only}`;
}

export const HANDOVER_STALE_HINT =
  "下面的交接是此前保存的摘要，可能稍有滞后；如与后面的最新对话冲突，以最新对话为准，任务进度请核对 Worker 实际状态。";

export function sessionPreambleHeader(options: {
  auto: boolean;
  hasSkills: boolean;
  transcriptPath: string | null;
  fromVendor?: string;
  toVendor?: string;
}): string {
  const why = options.auto ? "上一个会话对话太长，系统自动给你换了这个新会话" : "用户点了开新会话（上一个会话太长了）";
  const switchedVendor = options.fromVendor !== undefined && options.toVendor !== undefined && options.fromVendor !== options.toVendor;
  const reasonLine = switchedVendor
    ? `用户把你的厂商从 ${vendorLabel(options.fromVendor!)}（${options.fromVendor}）换成了 ${vendorLabel(options.toVendor!)}（${options.toVendor}），直接把之前的对话原话和记录转给了你；用户那边还是同一个对话，不用跟用户提换会话的事。提到的工具名按你自己的工具理解。`
    : `${why}，上一个会话写完交接后换成了你；用户那边还是同一个对话，不用跟用户提换会话的事。`;
  const transcript =
    switchedVendor && isAgentVendor(options.fromVendor!) && vendorSpec(options.fromVendor!).handover?.transcriptPortable === false
      ? `上一个会话的原始记录：格式是 ${options.fromVendor} 的，读不了，只看交接和原话`
      : transcriptLine(options.transcriptPath);
  return `【系统】这是新会话：你还是同一个项目经理，接着上一个会话干。${reasonLine}
下面${options.hasSkills ? "先是上一个会话加载过的技能索引，再" : ""}是上一个会话写的交接，和交接之前约 ${HANDOVER_RECENT_CHARS / 10_000} 万字你和用户的原话。交接写于切点，之后的事看下面的原话和 Worker 汇报目录。还在跑的 Worker 照常会把汇报发给你。做过的细节用 ${SEARCH_COMMANDS} 搜；${transcript}。
不用回复“已接上”：读完直接处理这段说明后面的那条消息。`;
}

export const HANDOVER_EMPTY_REASON = "handover_empty";

export const HANDOVER_NOT_WRITTEN_TEXT = "交接没写成，没换会话";
