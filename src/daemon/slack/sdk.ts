// 用 Slack 官方 Node SDK 实现 SlackTransport（@slack/web-api 8.x 的 WebClient、@slack/socket-mode 3.x 的 SocketModeClient）。
// 官方包由实现步骤装进 package.json，并同步 AGENTS.md「我们用的组件」；方案与骨架步不引入依赖。
import type { SlackTransport } from "./transport.ts";

export interface SlackSdkOptions {
  botToken: string;
  appToken: string;
  log: (line: string) => void;
}

/**
 * 后置：返回的传输层还没连；start 之后才开 Socket Mode。call 的 429 退避、Socket Mode 的 ack、
 * refresh_requested 与 warning 断线后的重连都交给官方包。
 */
export function createSlackSdkTransport(options: SlackSdkOptions): SlackTransport {
  throw new Error("未实现");
}
