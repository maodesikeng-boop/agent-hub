// Slack 终端命令（docs/slack-design.md「五分钟接入」）：`node <代码目录>/src/slack/main.ts <子命令>`，用户在终端里跑，
// 给还没有网页设置页、或在远端服务器上 ssh 进去配的时候用。和隧道命令一样经本机管理 socket run/admin.sock 找守护进程，
// 带界面令牌；守护进程那一半是 daemon/slack/setup.ts，和网页接口同一份。
// 子命令：
//   manifest            打印一键创建应用的网址和清单 JSON
//   connect             从标准输入读两行：机器人令牌（xoxb-）、应用级令牌（xapp-），不进命令行参数和 shell 历史
//   bind                打印绑定码，主人在 Slack 里私聊机器人发它
//   status              打印连接状态和频道
//   resync              照账本重新对一遍频道
//   disconnect [--archive-channels]
// 令牌只经标准输入进来，不回显、不打印。

export interface SlackCliIo {
  argv: string[];
  stdin: () => Promise<string>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** 请求本机守护进程的管理 socket，回 JSON。连不上、回错误都抛错，message 是给人看的。 */
  admin(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown>;
}

/** 后置：返回退出码：0 成功，1 守护进程报错或连不上，2 用法不对（打印用法）。 */
export function runSlackCli(io: SlackCliIo): Promise<number> {
  throw new Error("未实现");
}
