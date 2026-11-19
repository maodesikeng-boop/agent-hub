// 自建中继（docs/account-mesh-design.md「中继」）：Node 外壳，逻辑全在 relay/core.ts。
// HTTP 和 WebSocket 用已有的 fastify + @fastify/websocket（ws），账号数据存 node:sqlite。可以直接听公网端口，也可以放在 Caddy / nginx 后面。
// 不变量：每个账号一个 RelayAccountRoom，按需建、所有连接断开且空闲后丢掉（设备表在库里）；数据通道的内容不写日志、不落盘。

export interface NodeRelayOptions {
  /** 0 表示随便挑一个空端口（测试用）。 */
  port: number;
  host?: string;
  /** 账号数据库文件（node:sqlite）。 */
  dbFile: string;
  /** 对外的 origin（https://…），签名消息里要用；放在反代后面时填反代的地址。 */
  publicOrigin: string;
  /** 测试换成假的 GitHub。 */
  fetch?: typeof fetch;
  githubApiOrigin?: string;
  log?: (line: string) => void;
}

export interface RunningNodeRelay {
  port: number;
  close(): Promise<void>;
}

/** 后置：开始监听；POST /v1/register、控制连接、数据通道都按 relay/protocol.ts 的 RELAY_PATHS；close 后所有连接关掉、端口释放。 */
export function startNodeRelay(options: NodeRelayOptions): Promise<RunningNodeRelay> {
  throw new Error("未实现");
}
