// 飞书通道（docs/feishu-design.md）：守护进程里的一层适配器。账本、驱动、任务图不改流程，只在入口和出口各接一处：
// - 入：长连接事件先由 inbound.ts 解析、routing.ts 分流，再调账本原有的接口（postUserMessage、requestStop、answerAsk、
//   decideTaskNode、recheckUserBlocker、resolveRouterItem）或总助的 submitCommand；
// - 出：账本 onChange 的变化由 outbound.ts 投影成意图，再交给 stream.ts、cards.ts、files.ts 经传输层发出去。
// 不变量：
// - 账本是唯一的真相；飞书里点按钮、发消息和网页上一样走账本，账本推变化后两边各自刷新；
// - 长连接回调 3 秒内返回（只解析、入队；卡片点击先回 toast），处理排队，上限 FEISHU_INBOUND_QUEUE_MAX / FEISHU_OUTBOUND_QUEUE_MAX；
// - 飞书消息编号当 clientId（feishu:<message_id>），重推天然幂等；
// - 发到同一个群每秒不超过 FEISHU_CHAT_SENDS_PER_SECOND 条（飞书同一个群里机器人共享 5 QPS）；
// - 飞书挂了、凭证失效都不影响网页和 agent：这里的错误只记日志和状态，不往账本抛。
import type { ConversationId, Message, MessageId } from "../../shared/domain.ts";
import type { Ledger } from "../../shared/ledger.ts";
import type { RouterDispatcher } from "../router/dispatcher.ts";
import type { Db } from "../store/index.ts";
import type { FeishuSdkOptions, registerFeishuApp } from "./sdk.ts";
import type { FeishuSetupService } from "./setup.ts";
import type { FeishuTransport } from "./transport.ts";

/** 通道用到的账本接口。messagesAfter 是实现步骤要给 Ledger 加的（补发离线期间的消息）。 */
export type FeishuLedgerPort = Pick<
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

export interface FeishuServiceOptions {
  db: Db;
  ledger: FeishuLedgerPort;
  /** 总助：主人在单聊里的话交给它；没开总助分派引擎时是 null，单聊回“总助没开”。 */
  router: Pick<RouterDispatcher, "submitCommand"> | null;
  secretsFile: string;
  uploadsDir: string;
  sentFilesDir: string;
  /** 水果头像图片所在目录（avatars.ts 的 pmFruitImagePath）。 */
  avatarsDir: string;
  device: { id: string; name: string };
  log: (line: string) => void;
  /** 测试里换成假的传输层和假的扫码。 */
  createTransport?: (options: FeishuSdkOptions) => FeishuTransport;
  register?: typeof registerFeishuApp;
  now?: () => number;
}

export interface FeishuService {
  setup: FeishuSetupService;
  /** 后置：有凭证且没暂停就连长连接、订阅账本变化；没配过只订阅不连。连不上不抛错，状态里写原因。 */
  start(): Promise<void>;
  /** 后置：退订账本、关连接、取消扫码、清掉计时器和内存缓存。可以重复调。 */
  close(): Promise<void>;
}

/** 前置：迁移 0034 已跑。后置：返回的服务还没 start。 */
export function createFeishuService(options: FeishuServiceOptions): FeishuService {
  throw new Error("未实现");
}

