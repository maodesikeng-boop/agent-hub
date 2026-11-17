// Slack 通道（docs/slack-design.md）：守护进程里的一层适配器。账本、驱动、任务图一行不改，只在入口和出口各接一处：
// - 入：Socket Mode 事件先由 inbound.ts 解析、routing.ts 分流，再调账本原有的接口（postUserMessage、requestStop、answerAsk、
//   decideTaskNode、recheckUserBlocker、resolveRouterItem）或总助的 submitCommand；
// - 出：账本 onChange 的变化由 outbound.ts 投影成意图，再交给 stream.ts、cards.ts、files.ts 经传输层发出去。
// 不变量：
// - 账本是唯一的真相；Slack 里点按钮、发消息和网页上一样走账本，账本推变化后两边各自刷新；
// - 先 ack 再处理（传输层负责），处理排队，上限 SLACK_INBOUND_QUEUE_MAX / SLACK_OUTBOUND_QUEUE_MAX；
// - Slack 挂了、令牌失效都不影响网页和 agent：这里的错误只记日志和状态，不往账本抛。
import type { ConversationId, Message, MessageId } from "../../shared/domain.ts";
import type { Ledger } from "../../shared/ledger.ts";
import type { RouterDispatcher } from "../router/dispatcher.ts";
import type { Db } from "../store/index.ts";
import type { SlackSetupService } from "./setup.ts";
import type { SlackSdkOptions } from "./sdk.ts";
import type { SlackTransport } from "./transport.ts";

/** 通道用到的账本接口。messagesAfter 是这次要给 Ledger 加的（补发离线期间的消息）。 */
export type SlackLedgerPort = Pick<
  Ledger,
  | "snapshot"
  | "onChange"
  | "getMessage"
  | "postUserMessage"
  | "requestStop"
  | "answerAsk"
  | "resolveRouterItem"
  | "decideTaskNode"
  | "recheckUserBlocker"
> & {
  /** 后置：这个对话里编号大于 after 的消息，从小到大，最多 limit 条。对话不存在抛 ConversationNotFoundError。 */
  messagesAfter(conversationId: ConversationId, after: MessageId, limit: number): Message[];
};

export interface SlackServiceOptions {
  db: Db;
  ledger: SlackLedgerPort;
  /** 总助：总助频道里主人的话交给它；没开总助分派引擎时是 null，总助频道回“总助没开”。 */
  router: Pick<RouterDispatcher, "submitCommand"> | null;
  secretsFile: string;
  uploadsDir: string;
  sentFilesDir: string;
  device: { id: string; name: string };
  log: (line: string) => void;
  /** 测试里换成假的传输层。 */
  createTransport?: (options: SlackSdkOptions) => SlackTransport;
  now?: () => number;
}

export interface SlackService {
  setup: SlackSetupService;
  /**
   * 后置：有令牌且没暂停就连 Socket Mode、订阅账本变化；没配过只订阅不连（等 saveCredentials）。连不上不抛错，状态里写原因。
   */
  start(): Promise<void>;
  /** 后置：退订账本、关连接、清掉计时器和内存缓存。可以重复调。 */
  close(): Promise<void>;
}

/** 前置：迁移 0034 已跑。后置：返回的服务还没 start。 */
export function createSlackService(options: SlackServiceOptions): SlackService {
  throw new Error("未实现");
}

