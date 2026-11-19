// 账号组网的终端命令（docs/account-mesh-design.md「账号与登录」）：给没有浏览器的服务器用，和网页“设置 → 账号与设备”调同一组接口。
// node <代码目录>/src/mesh/main.ts <子命令>：login、status、approve <请求编号>、priority <设备…>、remove <设备>、logout。
// 经本机管理 socket run/admin.sock 找守护进程（客户端和飞书命令共用），要用跑守护进程的那个用户跑。

export interface MeshCliIo {
  argv: string[];
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** 请求本机守护进程的管理 socket，回 JSON。连不上、回错误都抛错，message 是给人看的。 */
  admin(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown>;
  /** 读一行（approve 时等用户核对后输入 y / n）。 */
  readLine(prompt: string): Promise<string>;
  /** 等授权、等对方核对时两次查状态之间等多久（测试换成立刻返回）。 */
  sleep(ms: number): Promise<void>;
}

/**
 * 后置：返回退出码：0 成功，1 守护进程报错、连不上、授权被拒或过期、核对不一致，2 用法不对（打印用法）。
 * login 打印 8 位码和网址，等到登录完成；本机需要批准时接着打印“等批准”和之后出现的核对码，等用户输入 y / n。
 */
export function runMeshCli(io: MeshCliIo): Promise<number> {
  throw new Error("未实现");
}
