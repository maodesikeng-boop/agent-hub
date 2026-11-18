// 飞书终端命令（docs/feishu-design.md「扫码接入」）：`node <代码目录>/src/feishu/main.ts <子命令>`，给还没有网页设置页、
// 或在远端服务器上 ssh 进去配的时候用。和隧道命令一样经本机管理 socket run/admin.sock 找守护进程，带界面令牌；
// 守护进程那一半是 daemon/feishu/setup.ts，和网页接口同一份。
// 子命令：
//   connect                       开始扫码建应用：终端里打出二维码，等手机飞书扫码确认，确认后打印接上的应用和机器人名
//   connect --manual [--lark]     手动接入：从标准输入读两行 App ID、App Secret，不进命令行参数和 shell 历史
//   bind                          手动接入后打印绑定码，主人在飞书里私聊机器人发它
//   status                        打印连接状态和项目群（含唤醒方式、访客档位）
//   policy <项目经理编号> [--trigger auto|mention_only] [--guest chat_only|collaborator|observer]
//   resync                        照账本重新对一遍项目群
//   disconnect [--dissolve-chats]
// App Secret 只经标准输入进来，不回显、不打印。

export interface FeishuCliIo {
  argv: string[];
  stdin: () => Promise<string>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** 请求本机守护进程的管理 socket，回 JSON。连不上、回错误都抛错，message 是给人看的。 */
  admin(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown>;
  /** 把链接画成终端里能扫的二维码（实现用已有依赖 qrcode-generator）。 */
  renderQr(url: string): string;
}

/** 后置：返回退出码：0 成功，1 守护进程报错、连不上或扫码被拒绝 / 过期，2 用法不对（打印用法）。 */
export function runFeishuCli(io: FeishuCliIo): Promise<number> {
  throw new Error("未实现");
}
