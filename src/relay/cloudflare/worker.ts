// Cloudflare 版中继（docs/account-mesh-design.md「中继」）：Worker 收 /v1/register 并把每个账号的连接交给该账号的 Durable Object，
// DO 里放一个 relay/core.ts 的 RelayAccountRoom。WebSocket 一律用休眠 API（acceptWebSocket），协议层 ping 用 setWebSocketAutoResponse 自动回。
// 不变量：
// - Durable Object 只用 SQLite 存储（免费档只开放这种），只存设备表和中心顺序；
// - 不在 DO 里开定时器、不持有出站连接，空闲时能休眠；过期检查放在每条消息之后调 room.sweep()；
// - 没有服务端密钥：wrangler.toml 里只有 GitHub API 地址这类公开配置。
// 实现时加 wrangler.toml 和 Workers 的类型包，把这个文件从根 tsconfig.json 挪到 src/relay/cloudflare/tsconfig.json；下面的接口只是骨架阶段让根类型检查能过的最小形状。

interface CfWebSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface CfDurableObjectState {
  acceptWebSocket(ws: CfWebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): CfWebSocket[];
}

interface CfDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface RelayWorkerEnv {
  ACCOUNTS: {
    idFromName(name: string): unknown;
    get(id: unknown): CfDurableObjectStub;
  };
  /** 对外的 origin（https://…），签名消息里要用。 */
  PUBLIC_ORIGIN: string;
  GITHUB_API_ORIGIN?: string;
}

/**
 * Worker 入口。
 * 后置：POST /v1/register 先验 GitHub token、按账号编号交给对应 DO；/v1/accounts/<账号>/… 的 WebSocket 升级交给该账号的 DO；
 * 别的路径 404；同一 IP 每分钟登记超过 RELAY_REGISTER_PER_IP_PER_MINUTE 次回 429。
 */
export function handleRelayRequest(request: Request, env: RelayWorkerEnv): Promise<Response> {
  throw new Error("未实现");
}

/** 一个账号一个对象。 */
export class RelayAccountObject {
  constructor(state: CfDurableObjectState, env: RelayWorkerEnv) {
    throw new Error("未实现");
  }

  /** 后置：控制连接和数据通道用 acceptWebSocket 收下；登记请求交给 room.register。 */
  fetch(request: Request): Promise<Response> {
    throw new Error("未实现");
  }

  /** 后置：控制连接的文本交给对应的 RelayControlHandle，数据通道的二进制交给 RelayChannelHandle；之后存 attachment、调 sweep。 */
  webSocketMessage(ws: CfWebSocket, message: string | ArrayBuffer): Promise<void> {
    throw new Error("未实现");
  }

  webSocketClose(ws: CfWebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    throw new Error("未实现");
  }
}
