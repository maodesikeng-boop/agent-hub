// 配置与状态（docs/slack-design.md「五分钟接入」）：界面服务的 /api/slack/* 和终端命令（src/slack/cli.ts 经 run/admin.sock）
// 都只调这里，两处行为一致。
// 不变量：
// - 令牌验过才存：auth.test 通过、机器人令牌带齐 SLACK_BOT_SCOPES、应用级令牌能开 Socket Mode 连接；
// - 绑定码只在内存里，一次一个，SLACK_BIND_CODE_TTL_MS 后失效，用一次就作废；
// - 任何返回值都不含令牌。
import type {
  SlackBindCodeResponse,
  SlackCredentialsRequest,
  SlackDisconnectRequest,
  SlackManifestResponse,
  SlackStatusView,
} from "../../shared/slack.ts";

/** 令牌、权限不对：message 是给人看的（写明缺哪个权限或哪个令牌不对），界面服务回 400。 */
export class SlackSetupError extends Error {}

export interface SlackSetupService {
  status(): SlackStatusView;
  manifest(): SlackManifestResponse;
  /**
   * 后置：验过就写 state/slack-secrets.json、存工作区，按新令牌重连，返回新状态（connecting 或 awaiting_owner）；
   * 不对抛 SlackSetupError，原有的令牌和连接不动。换了工作区时旧的主人和频道记录清空。
   */
  saveCredentials(input: SlackCredentialsRequest): Promise<SlackStatusView>;
  /** 前置：已填令牌。后置：发新码，旧码作废。已有主人时抛 SlackSetupError（换主人要先断开）。 */
  issueBindCode(): SlackBindCodeResponse;
  /** 后置：text（去掉首尾空白）是当前有效的码返回 true 并作废它；否则 false。 */
  consumeBindCode(text: string, now: number): boolean;
  /** 后置：照账本把频道对一遍（channels.ts），返回对完的状态。没连上时抛 SlackSetupError。 */
  resync(): Promise<SlackStatusView>;
  /** 后置：断开连接，删掉令牌文件和三张表；archiveChannels 为 true 时先把 Fusa 建的频道归档。 */
  disconnect(input: SlackDisconnectRequest): Promise<SlackStatusView>;
}
