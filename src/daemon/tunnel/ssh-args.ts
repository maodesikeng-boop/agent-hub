// 连入方 ssh 的参数和输出（docs/hub-tunnel-design.md 第 6 节）：参数只在这里拼，stderr 怎么认也在这里（两者都取决于 LogLevel）。
// 改参数要同时改 ssh-args.test.ts 的快照和方案第 6 节。
import { isAbsolute } from "node:path";
import { TUNNEL_ALIVE_COUNT_MAX, TUNNEL_ALIVE_INTERVAL_S, TUNNEL_CONNECT_TIMEOUT_S } from "../../shared/limits.ts";
import { isPort, isTunnelHost, isTunnelUser } from "../../shared/tunnel.ts";

export interface TunnelSshConfig {
  host: string;
  sshPort: number;
  user: string;
  /** 本机在中心上的槽位端口：-R <它>:<peerSocket>。 */
  listenPort: number;
  /** 中心的设备入口端口：-L <hubSocket>:127.0.0.1:<它>。 */
  hubEntryPort: number;
  keyFile: string;
  knownHostsFile: string;
  /** 本机设备入口 run/peer.sock（块 A）。 */
  peerSocket: string;
  /** ssh -L 建的 run/tunnel/hub.sock。 */
  hubSocket: string;
}

/**
 * known_hosts 里中心那一行用的名字（HostKeyAlias）：按别名钉主机公钥，跟连的是 IP 还是域名、哪个端口无关，
 * known_hosts 里也不用写 [host]:port。
 */
export const TUNNEL_HOST_KEY_ALIAS = "agent-hub-hub";

export const knownHostsLine = (hostKey: string): string => `${TUNNEL_HOST_KEY_ALIAS} ${hostKey}\n`;

/** socket 路径进 -R / -L 的参数：要绝对路径，不能有冒号和空白（ssh 用冒号分隔）。 */
function socketPath(path: string, what: string): string {
  if (!isAbsolute(path) || /[:\s]/.test(path)) throw new Error(`tunnel ${what} must be an absolute path without ':' or spaces: ${path}`);
  return path;
}

/**
 * 隧道 ssh 的参数（命令是 PATH 里的 ssh）。只读本方案生成的文件：
 * - `-F /dev/null`：不读用户 ~/.ssh/config，也不读系统 ssh_config（命令行给了配置文件就不读系统那份），ProxyCommand、ControlMaster 混不进来；
 * - 钥匙只用 state/tunnel/id_ed25519，不问 ssh-agent；BatchMode 不弹任何提示；
 * - 主机公钥只认 known_hosts 里按别名钉死的那把 ed25519，不认就失败（hostkey_mismatch），也不让 ssh 往里加别的；
 * - ExitOnForwardFailure：-R、-L 有一条建不起来就退出，交给退避重连；
 * - StreamLocalBindUnlink：ssh 退出时不删 -L 建的 hub.sock，留着的旧文件会让下次 -L 建不起来（配上 ExitOnForwardFailure 就一直重连失败），
 *   这个选项让 ssh 建之前先删掉旧的；
 * - ServerAlive：15 秒一次心跳、3 次没回断开；
 * - LogLevel=DEBUG1：两条转发都建好时 ssh 只在 debug1 里说一句 “remote forward success”，靠它判断连上了（classifySshLine）。
 */
export function buildSshArgs(c: TunnelSshConfig): string[] {
  if (!isTunnelHost(c.host)) throw new Error(`invalid tunnel host: ${c.host}`);
  if (!isTunnelUser(c.user)) throw new Error(`invalid tunnel user: ${c.user}`);
  for (const port of [c.sshPort, c.listenPort, c.hubEntryPort]) if (!isPort(port)) throw new Error(`invalid tunnel port: ${port}`);
  const option = (value: string) => ["-o", value];
  return [
    "-N",
    "-T",
    "-F",
    "/dev/null",
    "-i",
    socketPath(c.keyFile, "key file"),
    ...option("IdentitiesOnly=yes"),
    ...option("IdentityAgent=none"),
    ...option("PreferredAuthentications=publickey"),
    ...option("BatchMode=yes"),
    ...option("StrictHostKeyChecking=yes"),
    ...option(`UserKnownHostsFile=${socketPath(c.knownHostsFile, "known_hosts file")}`),
    ...option("GlobalKnownHostsFile=/dev/null"),
    ...option(`HostKeyAlias=${TUNNEL_HOST_KEY_ALIAS}`),
    ...option("HostKeyAlgorithms=ssh-ed25519"),
    ...option("UpdateHostKeys=no"),
    ...option("ExitOnForwardFailure=yes"),
    ...option("StreamLocalBindUnlink=yes"),
    ...option(`ServerAliveInterval=${TUNNEL_ALIVE_INTERVAL_S}`),
    ...option(`ServerAliveCountMax=${TUNNEL_ALIVE_COUNT_MAX}`),
    ...option(`ConnectTimeout=${TUNNEL_CONNECT_TIMEOUT_S}`),
    ...option("LogLevel=DEBUG1"),
    "-p",
    String(c.sshPort),
    "-R",
    `${c.listenPort}:${socketPath(c.peerSocket, "peer socket")}`,
    "-L",
    `${socketPath(c.hubSocket, "hub socket")}:127.0.0.1:${c.hubEntryPort}`,
    `${c.user}@${c.host}`,
  ];
}

/** 看 ssh 的一行 stderr 能说明什么：connected（两条转发都建好了）、两种不自动重试的失败，别的回 null（退出时按普通失败退避）。 */
export type SshLineVerdict = "connected" | "auth_failed" | "hostkey_mismatch" | null;

export function classifySshLine(line: string): SshLineVerdict {
  // -R 是最后一条请求的转发，它的成功回执到了就说明 -L（本地先建）和 -R 都好了
  if (/^debug1: remote forward success for: listen /.test(line)) return "connected";
  if (line.startsWith("debug")) return null;
  if (/Permission denied \(/.test(line)) return "auth_failed";
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|host key is known for .* you have requested strict checking/i.test(line)) {
    return "hostkey_mismatch";
  }
  return null;
}
