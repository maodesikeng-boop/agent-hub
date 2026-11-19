// 自建中继的命令：node <代码目录>/src/relay/node/main.ts --port <端口> --origin https://<对外地址> [--db <文件>]。

/** 后置：解析参数并起 startNodeRelay，收到 SIGINT / SIGTERM 时关掉再退出；参数不对打印用法，返回 2。 */
export function runRelayCli(argv: string[], io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } }): Promise<number> {
  throw new Error("未实现");
}
