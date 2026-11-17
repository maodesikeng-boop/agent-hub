// Slack 的外部边界（docs/slack-design.md「做法比较」）：Fusa 用到的 Web API 方法和 Socket Mode 收到的原始信封。
// 只有 sdk.ts 引官方包（@slack/web-api、@slack/socket-mode），别的文件只认这里的接口，测试用假的实现。
// 不变量：这里的入参出参都是 Slack 原样的 JSON 形状（蛇形命名、裸字符串编号）；进领域前一律过 inbound.ts 的解析。

/** 用到的 Web API 方法和参数（只列 Fusa 传的字段）。 */
export interface SlackMethodArgs {
  "auth.test": Record<string, never>;
  "conversations.create": { name: string; is_private: true };
  "conversations.rename": { channel: string; name: string };
  "conversations.archive": { channel: string };
  "conversations.unarchive": { channel: string };
  "conversations.invite": { channel: string; users: string };
  "conversations.setPurpose": { channel: string; purpose: string };
  "conversations.members": { channel: string; cursor?: string; limit: number };
  "conversations.open": { users: string };
  "users.info": { user: string };
  "chat.postMessage": { channel: string; text: string; blocks?: unknown[]; thread_ts?: string };
  "chat.update": { channel: string; ts: string; text: string; blocks?: unknown[] };
  "chat.postEphemeral": { channel: string; user: string; text: string };
  "chat.getPermalink": { channel: string; message_ts: string };
  "views.open": { trigger_id: string; view: Record<string, unknown> };
  "chat.startStream": { channel: string; thread_ts: string; recipient_user_id: string; recipient_team_id: string; markdown_text?: string };
  "chat.appendStream": { channel: string; ts: string; markdown_text: string };
  "chat.stopStream": { channel: string; ts: string; blocks?: unknown[] };
}

export type SlackMethod = keyof SlackMethodArgs;

/** Web API 的回包：ok 为 false 时 error 是 Slack 的错误码（name_taken、missing_scope……）。 */
export interface SlackApiResult {
  ok: boolean;
  error?: string;
  /** missing_scope 时 Slack 给的“需要的权限”。 */
  needed?: string;
  [key: string]: unknown;
}

export interface SlackUploadInput {
  channel: string;
  threadTs?: string;
  filename: string;
  /** 本机文件的绝对路径（sent-files 副本或附件）。 */
  path: string;
  title?: string;
}

/** Socket Mode 送来的一个信封（events_api、interactive、slash_commands 等），还没解析。 */
export interface SlackRawEnvelope {
  envelopeId: string;
  type: string;
  payload: unknown;
  retryAttempt: number | null;
}

export interface SlackSocketHandlers {
  /** 每个信封调一次；传输层在调它之前已经 ack（3 秒内必须回），这里出错不影响 ack。 */
  onEnvelope(envelope: SlackRawEnvelope): void;
  /** 连上（含重连成功）时调：服务据此重对频道成员、补发离线期间的消息。 */
  onConnected(): void;
  /** 断开时调；reason 是 Slack 给的（refresh_requested、link_disabled……）或本地错误。传输层自己重连。 */
  onDisconnected(reason: string): void;
}

/**
 * 守护进程看到的 Slack。sdk.ts 用官方包实现；测试用假的。
 * 不变量：call 遇到 429 由实现按 Retry-After 退避重试，调用方只看到最终结果；
 * 令牌失效（invalid_auth、account_inactive、token_revoked）抛 SlackAuthError，不重试。
 */
export interface SlackTransport {
  call<M extends SlackMethod>(method: M, args: SlackMethodArgs[M]): Promise<SlackApiResult>;
  /** files.getUploadURLExternal + 上传 + files.completeUploadExternal。返回文件编号。 */
  upload(input: SlackUploadInput): Promise<{ fileId: string }>;
  /** 用机器人令牌下载用户贴的文件（url_private）。超过 maxBytes 中止并抛错，不返回半截内容。 */
  download(url: string, maxBytes: number): Promise<Buffer>;
  /** 开 Socket Mode 长连接（apps.connections.open 拿地址），断了自己重连，直到 stop。 */
  start(handlers: SlackSocketHandlers): Promise<void>;
  stop(): Promise<void>;
}

/** 令牌失效或被撤销：服务把状态改成 auth_failed，等用户重填。 */
export class SlackAuthError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`slack auth failed: ${code}`);
    this.code = code;
  }
}
