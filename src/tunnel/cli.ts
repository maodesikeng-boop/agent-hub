// 隧道命令（docs/hub-tunnel-design.md 第 7 节）：`node <仓库>/src/tunnel/main.ts <子命令>`，用户在终端里跑（不是 agent 用的 hub 命令）。
// 两半分开：
// - 守护进程那一半（专用钥匙、槽位、邀请码、收连接码）经本机管理 socket run/admin.sock（daemon/tunnel/admin.ts）；
// - 要 root 的那一半（建用户、sshd 片段、钥匙行；删设备时断旧会话）是 scripts/tunnel-sshd.sh，这里用 sudo -n 调。
// 管理员钥匙只在 join 起的 ssh 里用，守护进程不读、不存。
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CONNECTION_CODE_PREFIX,
  TUNNEL_SSH_USER,
  decodeConnectionCode,
  encodeConnectionCode,
  isPort,
  isTunnelHost,
  isTunnelName,
  parseEd25519PublicKey,
} from "../shared/tunnel.ts";

/** 要 root 的那一半。中心上的代码目录里的这个文件（provision-linux.sh 装在 ~/agent-hub）。 */
export const TUNNEL_ROOT_SCRIPT = fileURLToPath(new URL("../../scripts/tunnel-sshd.sh", import.meta.url));
/** 中心上 sshd 的 ed25519 主机公钥（写进连接码，连入方钉进 known_hosts）。 */
export const HOST_KEY_FILE = "/etc/ssh/ssh_host_ed25519_key.pub";
/** join 在中心上跑的命令：node <代码目录>/src/tunnel/main.ts。代码目录默认相对中心用户的主目录（provision-linux.sh 的 APP_DIR_NAME）。 */
export const DEFAULT_REMOTE_DIR = "agent-hub";
const REMOTE_ENTRY = "src/tunnel/main.ts";

/** 守护进程的管理 socket 连不上（守护进程没在跑）。 */
export class AdminUnavailableError extends Error {
  constructor(socketPath: string) {
    super(`连不上本机守护进程（${socketPath}）：先启动 agent-hub 守护进程`);
  }
}
/** 管理 socket 回了错误。 */
export class AdminError extends Error {}

export interface TunnelCliIo {
  argv: string[];
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** 请求本机守护进程的管理 socket，回 JSON。连不上抛 AdminUnavailableError，回错误抛 AdminError。 */
  admin(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  /** 跑外部命令：标准输入、标准错误接用户终端，标准输出收下来。 */
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
  readFile(path: string): string;
  hostname(): string;
}

export const TUNNEL_USAGE = `用法（node <代码目录>/src/tunnel/main.ts <子命令>）：
连入方（Mac）：
  join [-i <管理员私钥>] [-p <ssh 端口>] [--name <设备名>] [--remote-dir <中心上的代码目录>] <管理员@中心地址>
        一条命令连到中心：本机守护进程生成专用钥匙 → 用管理员钥匙 ssh 到中心跑 add → 连接码交给本机守护进程。
        设备名默认取本机名；中心上的代码目录默认 ~/${DEFAULT_REMOTE_DIR}
  key [--regenerate]        打印本机专用公钥（在别的机器上跑 add 时用）
  connect <连接码>          把 add 打出来的连接码交给本机守护进程（兜底：add 是在别的机器上跑的）
中心（东京，用有免密 sudo 的管理员用户跑）：
  add --name <设备名> --pubkey <公钥一行> --host <中心的公网地址> [--ssh-port 22]
        分槽位、出邀请码（守护进程）→ 建隧道用户、写 sshd 片段、写钥匙行（sudo）→ 标准输出打一行连接码
  remove --name <设备名>    删钥匙行、断这台的现存会话（sudo）→ 收回槽位（守护进程）
重复跑结果一样：已经对的不动，中途失败再跑一次补齐。
`;

class UsageError extends Error {}

/** 单引号包起来给远端 shell；只有安全字符的原样。 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 本机名 → 设备名：小写，去掉 .local 之类的后缀，别的字符换成 -。 */
export function defaultDeviceName(hostname: string): string {
  const slug = hostname
    .toLowerCase()
    .split(".")[0]!
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return isTunnelName(slug) ? slug : "device";
}

function parse(argv: string[], options: Record<string, { type: "string" | "boolean"; short?: string }>, positionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== positionals) throw new UsageError(positionals === 0 ? "多了参数" : `要 ${positionals} 个参数`);
  return parsed as { values: Record<string, string | boolean | undefined>; positionals: string[] };
}

function need(values: Record<string, string | boolean | undefined>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || value === "") throw new UsageError(`缺少 --${key}`);
  return value;
}

function parsePort(raw: string | boolean | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (typeof raw !== "string" || !/^\d+$/.test(raw) || !isPort(port)) throw new UsageError(`端口不对：${String(raw)}`);
  return port;
}

const expect = <T>(value: unknown, check: (v: Record<string, unknown>) => boolean): T => {
  if (typeof value !== "object" || value === null || !check(value as Record<string, unknown>)) throw new AdminError("守护进程的回复不对");
  return value as T;
};

async function add(io: TunnelCliIo, argv: string[]): Promise<number> {
  const { values } = parse(argv, { name: { type: "string" }, pubkey: { type: "string" }, host: { type: "string" }, "ssh-port": { type: "string" } }, 0);
  const name = need(values, "name");
  const publicKey = need(values, "pubkey");
  const host = need(values, "host");
  const sshPort = parsePort(values["ssh-port"], 22);
  if (!isTunnelName(name)) throw new UsageError("设备名只能用小写字母、数字和 -，1–32 个，不以 - 开头");
  if (parseEd25519PublicKey(publicKey) === null) throw new UsageError("--pubkey 要是一行 ssh-ed25519 公钥");
  if (!isTunnelHost(host)) throw new UsageError(`中心地址不对：${host}`);

  // 1. 守护进程：分槽位、出邀请码
  const grant = expect<{ port: number; entryPort: number; invite: string }>(
    await io.admin("POST", "/tunnel/slots", { name, publicKey }),
    (v) => isPort(v.port) && isPort(v.entryPort) && typeof v.invite === "string",
  );
  io.stderr.write(`[tunnel] ${name} 的槽位端口 ${grant.port}\n`);
  // 2. root：隧道用户、sshd 片段、钥匙行（按现状比对，已经对的不动）
  const root = await io.run("sudo", [
    "-n",
    TUNNEL_ROOT_SCRIPT,
    "add-key",
    "--name",
    name,
    "--port",
    String(grant.port),
    "--entry-port",
    String(grant.entryPort),
    "--pubkey",
    publicKey,
  ]);
  if (root.code !== 0) {
    io.stderr.write(`[tunnel] sudo ${TUNNEL_ROOT_SCRIPT} 失败（退出码 ${root.code}）：要用有免密 sudo 的管理员用户跑；修好后重跑同一条命令\n`);
    return 1;
  }
  // 3. 连接码
  const hostKey = parseEd25519PublicKey(io.readFile(HOST_KEY_FILE));
  if (hostKey === null) throw new AdminError(`${HOST_KEY_FILE} 不是 ed25519 主机公钥`);
  io.stdout.write(
    `${encodeConnectionCode({
      host,
      sshPort,
      user: TUNNEL_SSH_USER,
      hostKey: `ssh-ed25519 ${hostKey.body}`,
      listenPort: grant.port,
      entryPort: grant.entryPort,
      invite: grant.invite,
    })}\n`,
  );
  return 0;
}

async function remove(io: TunnelCliIo, argv: string[]): Promise<number> {
  const { values } = parse(argv, { name: { type: "string" } }, 0);
  const name = need(values, "name");
  if (!isTunnelName(name)) throw new UsageError("设备名只能用小写字母、数字和 -，1–32 个，不以 - 开头");
  // 先断权限（钥匙行、现存会话），再收槽位
  const root = await io.run("sudo", ["-n", TUNNEL_ROOT_SCRIPT, "remove-key", "--name", name]);
  if (root.code !== 0) {
    io.stderr.write(`[tunnel] sudo ${TUNNEL_ROOT_SCRIPT} 失败（退出码 ${root.code}）\n`);
    return 1;
  }
  const { removed } = expect<{ removed: { port: number } | null }>(await io.admin("POST", "/tunnel/slots/remove", { name }), (v) => "removed" in v);
  io.stderr.write(removed === null ? `[tunnel] 守护进程里本来就没有 ${name} 的槽位\n` : `[tunnel] 收回了 ${name} 的槽位 ${removed.port}\n`);
  return 0;
}

async function key(io: TunnelCliIo, argv: string[]): Promise<string> {
  const { values } = parse(argv, { regenerate: { type: "boolean" } }, 0);
  const { publicKey } = expect<{ publicKey: string }>(
    await io.admin("POST", "/tunnel/key", values.regenerate === true ? { regenerate: true } : {}),
    (v) => typeof v.publicKey === "string",
  );
  return publicKey;
}

async function connect(io: TunnelCliIo, code: string): Promise<void> {
  const res = expect<{ status: unknown }>(await io.admin("POST", "/tunnel/connect", { code }), (v) => "status" in v);
  const state = (res.status as { state?: unknown } | null)?.state;
  io.stderr.write(`[tunnel] 连接码已交给本机守护进程${typeof state === "string" ? `，隧道 ${state}` : ""}\n`);
}

async function join(io: TunnelCliIo, argv: string[]): Promise<number> {
  const { values, positionals } = parse(
    argv,
    { identity: { type: "string", short: "i" }, port: { type: "string", short: "p" }, name: { type: "string" }, "remote-dir": { type: "string" } },
    1,
  );
  const dest = positionals[0]!;
  if (dest.startsWith("-")) throw new UsageError(`中心地址不对：${dest}`);
  const name = typeof values.name === "string" ? values.name : defaultDeviceName(io.hostname());
  if (!isTunnelName(name)) throw new UsageError("设备名只能用小写字母、数字和 -，1–32 个，不以 - 开头");
  const sshOpts: string[] = [];
  if (typeof values.identity === "string") sshOpts.push("-i", values.identity);
  if (values.port !== undefined) sshOpts.push("-p", String(parsePort(values.port, 22)));
  const remoteDir = typeof values["remote-dir"] === "string" ? values["remote-dir"].replace(/\/+$/, "") : DEFAULT_REMOTE_DIR;

  // 1. 本机守护进程生成专用钥匙
  const publicKey = await key(io, []);
  // 2. 中心的真实地址、端口（用户可能写的是 ~/.ssh/config 里的别名，守护进程的 ssh 不读那个文件）
  const resolved = await io.run("ssh", [...sshOpts, "-G", dest]);
  const field = (k: string) => new RegExp(`^${k} (.+)$`, "m").exec(resolved.stdout)?.[1]?.trim();
  const host = field("hostname");
  const sshPort = Number(field("port") ?? "22");
  if (resolved.code !== 0 || host === undefined || !isTunnelHost(host) || !isPort(sshPort)) {
    io.stderr.write(`[tunnel] 解析不出 ${dest} 的地址（ssh -G）\n`);
    return 1;
  }
  // 3. 用户自己的管理员钥匙 ssh 到中心跑 add（在用户终端里跑，守护进程碰不到管理员钥匙）
  const remote = [
    "node",
    `${remoteDir}/${REMOTE_ENTRY}`,
    "add",
    "--name",
    name,
    "--host",
    host,
    "--ssh-port",
    String(sshPort),
    "--pubkey",
    publicKey,
  ]
    .map(shellQuote)
    .join(" ");
  io.stderr.write(`[tunnel] 在 ${dest} 上加设备 ${name}……\n`);
  const result = await io.run("ssh", [...sshOpts, dest, remote]);
  const code = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .reverse()
    .find((line) => line.startsWith(CONNECTION_CODE_PREFIX));
  if (result.code !== 0 || code === undefined) {
    io.stderr.write(`[tunnel] 中心上那一步没成功（退出码 ${result.code}），看上面的输出；修好后重跑同一条命令\n`);
    return 1;
  }
  // 4. 连接码交给本机守护进程
  await connect(io, code);
  io.stdout.write(`已连到中心 ${host}（设备名 ${name}）\n`);
  return 0;
}

export async function runTunnelCli(io: TunnelCliIo): Promise<number> {
  const [command, ...rest] = io.argv;
  try {
    switch (command) {
      case "add":
        return await add(io, rest);
      case "remove":
        return await remove(io, rest);
      case "join":
        return await join(io, rest);
      case "key":
        io.stdout.write(`${await key(io, rest)}\n`);
        return 0;
      case "connect": {
        const { positionals } = parse(rest, {}, 1);
        if (decodeConnectionCode(positionals[0]!) === null) throw new UsageError("连接码不对：要中心上 add 打出来的那一整行（ahtun1_ 开头）");
        await connect(io, positionals[0]!.trim());
        return 0;
      }
      case "help":
      case "--help":
        io.stdout.write(TUNNEL_USAGE);
        return 0;
      default:
        throw new UsageError(command === undefined ? "缺少子命令" : `没有这个子命令：${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`[tunnel] ${error.message}\n\n${TUNNEL_USAGE}`);
      return 2;
    }
    io.stderr.write(`[tunnel] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
