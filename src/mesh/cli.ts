// 账号组网的终端命令（docs/account-mesh-design.md「账号与登录」）：给没有浏览器的服务器用，和网页“设置 → 账号与设备”调同一组接口。
// node <代码目录>/src/mesh/main.ts <子命令>：login、status、approve <请求编号>、priority <设备…>、remove <设备>、logout。
// 经本机管理 socket run/admin.sock 找守护进程（客户端和飞书命令共用），要用跑守护进程的那个用户跑。
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { DeviceId } from "../shared/api.ts";
import { MESH_CLI_MAX_POLLS, MESH_CLI_POLL_MS } from "../shared/limits.ts";
import type { AccountStatusView, MeshApprovalView } from "../shared/mesh.ts";

export const MESH_USAGE = `用法：node src/mesh/main.ts <子命令>
  login [--relay <网址>] [--client-id <ClientID>]  用 GitHub 设备码登录
  status                    查看账号、中继状态、设备列表与中心顺序
  approve <请求编号>        核对并批准新设备加入
  priority <设备编号…>      设置中心顺序
  remove <设备编号>         从账号中移除设备
  logout                    本机退出账号
`;

class UsageError extends Error {}

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

function parse(args: string[], options: ParseArgsOptionsConfig = {}) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

const formatSas = (sas: string) => `${sas.slice(0, 3)} ${sas.slice(3)}`;

function formatStatus(status: AccountStatusView): string {
  if (status.state === "signed_out") {
    return status.lastError ? `状态：未登录（上次原因：${status.lastError}）\n` : "状态：未登录\n";
  }
  if (status.state === "signing_in") {
    return `状态：登录中\n网址：${status.verificationUri}\n登录码：${status.userCode}\n`;
  }
  if (status.state === "awaiting_approval") {
    const lines = [`状态：等批准`, `账号：${status.login.login}`, `中继：${status.relay}`];
    if (status.approval !== null) {
      lines.push(
        status.approval.sas === null
          ? `核对：等待 ${status.approval.device.name}（${status.approval.requestId}）`
          : `核对码：${formatSas(status.approval.sas)}（${status.approval.device.name}）`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
  const names = new Map(status.devices.map((d) => [d.id, d.name]));
  const holder = status.feishuHolder === null ? "无" : `${names.get(status.feishuHolder) ?? status.feishuHolder}（${status.feishuHolder}）`;
  const lines = [
    `账号：${status.login.login}（${status.accountId}）`,
    `中继：${status.relay}（${status.relayUrl}）`,
    `当前中心：${holder}`,
    `中心顺序：${status.centerPriority.map((id, i) => `${i + 1}.${names.get(id) ?? id}`).join(" ") || "无"}`,
    "设备：",
    ...status.devices.map((d) => {
      const where = d.self ? "本机" : d.online ? (d.link ?? "在线") : "离线";
      return `  ${d.name}  ${d.id}  ${d.platform}  ${where}`;
    }),
  ];
  if (status.approvals.length > 0) {
    lines.push(
      "待批准：",
      ...status.approvals.map((a) => `  ${a.device.name}  ${a.requestId}  ${a.device.platform}${a.sas ? `  核对码 ${formatSas(a.sas)}` : ""}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function confirmSas(io: MeshCliIo, approval: MeshApprovalView): Promise<AccountStatusView> {
  io.stdout.write(`核对码：${formatSas(approval.sas!)}（设备：${approval.device.name}）\n`);
  const answer = (await io.readLine("两台电脑显示的 6 位数一致吗？[y/N] ")).trim().toLowerCase();
  const match = answer === "y" || answer === "yes";
  const next = (await io.admin("POST", "/mesh/approvals/answer", { requestId: approval.requestId, match })) as AccountStatusView;
  if (!match) throw new Error("核对码不一致，本次批准已作废");
  return next;
}

async function handleLogin(io: MeshCliIo, args: string[]): Promise<number> {
  const { values, positionals } = parse(args, { relay: { type: "string" }, "client-id": { type: "string" } });
  if (positionals.length > 0) throw new UsageError("login 不收位置参数");
  const relayUrl = typeof values.relay === "string" && values.relay.trim() !== "" ? values.relay.trim() : undefined;
  const githubClientId = typeof values["client-id"] === "string" && values["client-id"].trim() !== "" ? values["client-id"].trim() : undefined;
  const body = {
    ...(relayUrl === undefined ? {} : { relayUrl }),
    ...(githubClientId === undefined ? {} : { githubClientId }),
  };
  let status = (await io.admin("POST", "/mesh/login", body)) as AccountStatusView;
  if (status.state === "signing_in") {
    io.stdout.write(`请在浏览器打开 ${status.verificationUri} 输入登录码：${status.userCode}\n`);
  }
  let printedWaiting = false;
  const answered = new Set<string>();
  for (let i = 0; i < MESH_CLI_MAX_POLLS; i++) {
    if (status.state === "signed_in") {
      io.stdout.write(`已登录账号 ${status.login.login}（${status.accountId}）\n`);
      return 0;
    }
    if (status.state === "signed_out") {
      throw new Error(status.lastError ?? "登录未完成");
    }
    if (status.state === "awaiting_approval") {
      if (!printedWaiting) {
        io.stdout.write(`已登录 ${status.login.login}，等批准（请在账号里已有的电脑上点核对）\n`);
        printedWaiting = true;
      }
      if (status.approval !== null && status.approval.sas !== null && !answered.has(status.approval.requestId)) {
        answered.add(status.approval.requestId);
        status = await confirmSas(io, status.approval);
        continue;
      }
    }
    await io.sleep(MESH_CLI_POLL_MS);
    status = (await io.admin("GET", "/mesh/status")) as AccountStatusView;
  }
  throw new Error("等待登录或批准超时");
}

async function handleApprove(io: MeshCliIo, args: string[]): Promise<number> {
  const { positionals } = parse(args);
  if (positionals.length !== 1) throw new UsageError("approve 需要 1 个请求编号");
  const requestId = positionals[0]!;
  let status = (await io.admin("POST", "/mesh/approvals/begin", { requestId })) as AccountStatusView;
  let approval: MeshApprovalView | undefined;
  for (let i = 0; i < MESH_CLI_MAX_POLLS; i++) {
    if (status.state !== "signed_in") throw new Error("本机尚未加入账号");
    approval = status.approvals.find((a) => a.requestId === requestId);
    if (approval === undefined) throw new Error("没有这条等批准的请求，或已过期");
    if (approval.sas !== null) break;
    await io.sleep(MESH_CLI_POLL_MS);
    status = (await io.admin("GET", "/mesh/status")) as AccountStatusView;
  }
  if (approval === undefined || approval.sas === null) throw new Error("等待对方亮出核对码超时");
  status = await confirmSas(io, approval);
  for (let i = 0; i < MESH_CLI_MAX_POLLS; i++) {
    if (status.state !== "signed_in") throw new Error("本机已不在账号里");
    if (status.devices.some((d) => d.id === requestId)) {
      io.stdout.write(`已批准 ${approval.device.name}（${requestId}）\n`);
      return 0;
    }
    if (!status.approvals.some((a) => a.requestId === requestId)) {
      throw new Error("对方拒绝或取消了核对");
    }
    await io.sleep(MESH_CLI_POLL_MS);
    status = (await io.admin("GET", "/mesh/status")) as AccountStatusView;
  }
  throw new Error("等待对方确认核对码超时");
}

async function handlePriority(io: MeshCliIo, args: string[]): Promise<number> {
  const { positionals } = parse(args);
  if (positionals.length === 0) throw new UsageError("priority 至少要给 1 台设备");
  const current = (await io.admin("GET", "/mesh/status")) as AccountStatusView;
  if (current.state !== "signed_in") throw new Error("还没登录账号");
  const priority: DeviceId[] = positionals.map((token) => {
    const found = current.devices.find((d) => d.id === token || d.name === token);
    if (found === undefined) throw new Error(`设备 ${token} 不在账号里`);
    return found.id;
  });
  const updated = (await io.admin("PUT", "/mesh/priority", { priority })) as AccountStatusView;
  io.stdout.write(formatStatus(updated));
  return 0;
}

async function dispatch(io: MeshCliIo): Promise<number> {
  const [sub, ...rest] = io.argv;
  if (sub === undefined || sub === "--help" || sub === "-h") throw new UsageError("请指定子命令");
  switch (sub) {
    case "login":
      return handleLogin(io, rest);
    case "status": {
      const { positionals } = parse(rest);
      if (positionals.length > 0) throw new UsageError("status 不收参数");
      const status = (await io.admin("GET", "/mesh/status")) as AccountStatusView;
      io.stdout.write(formatStatus(status));
      return 0;
    }
    case "approve":
      return handleApprove(io, rest);
    case "priority":
      return handlePriority(io, rest);
    case "remove": {
      const { positionals } = parse(rest);
      if (positionals.length !== 1) throw new UsageError("remove 需要 1 个设备编号");
      await io.admin("POST", "/mesh/devices/remove", { id: positionals[0]! });
      io.stdout.write(`已移除 ${positionals[0]!}\n`);
      return 0;
    }
    case "logout": {
      const { positionals } = parse(rest);
      if (positionals.length > 0) throw new UsageError("logout 不收参数");
      const next = (await io.admin("POST", "/mesh/logout", {})) as AccountStatusView | undefined;
      io.stdout.write("已退出账号\n");
      if (next?.state === "signed_out" && next.remoteRevokePending && next.lastError) {
        io.stdout.write(`${next.lastError}\n`);
      }
      return 0;
    }
    default:
      throw new UsageError(`不认识的子命令：${sub}`);
  }
}

/**
 * 后置：返回退出码：0 成功，1 守护进程报错、连不上、授权被拒或过期、核对不一致，2 用法不对（打印用法）。
 * login 打印 8 位码和网址，等到登录完成；本机需要批准时接着打印“等批准”和之后出现的核对码，等用户输入 y / n。
 */
export async function runMeshCli(io: MeshCliIo): Promise<number> {
  try {
    return await dispatch(io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${MESH_USAGE}`);
      return 2;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
