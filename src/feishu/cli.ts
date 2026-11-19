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

import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import {
  FEISHU_GUEST_TIERS,
  FEISHU_TRIGGER_MODES,
  type FeishuBindCodeResponse,
  type FeishuChatView,
  type FeishuGuestTier,
  type FeishuStatusView,
  type FeishuTriggerMode,
} from "../shared/feishu.ts";
import { FEISHU_CLI_POLL_MS } from "../shared/limits.ts";

export const FEISHU_USAGE = `用法：node src/feishu/main.ts <子命令>
  connect                       扫码建飞书应用（手机飞书扫终端里的二维码）
  connect --manual [--lark]     手动接入：从标准输入读两行 App ID、App Secret
  bind                          手动接入后打印绑定码，在飞书里私聊机器人发它
  status                        连接状态和项目群
  policy <项目经理编号> [--trigger ${FEISHU_TRIGGER_MODES.join("|")}] [--guest ${FEISHU_GUEST_TIERS.join("|")}]
  resync                        照账本重新对一遍项目群
  disconnect [--dissolve-chats] 断开（加 --dissolve-chats 一起解散项目群）
`;

class UsageError extends Error {}

const TRIGGER_TEXT: Readonly<Record<FeishuTriggerMode, string>> = { auto: "只有主人时直聊，有别人时 @机器人", mention_only: "一直要 @机器人" };
const TIER_TEXT: Readonly<Record<FeishuGuestTier, string>> = { chat_only: "仅对话", collaborator: "协作者", observer: "只读" };

function chatLine(chat: FeishuChatView): string {
  const who = chat.target.kind === "router" ? "总助单聊" : `项目经理 ${chat.target.pmId}「${chat.name}」`;
  if (chat.target.kind === "router") return `  ${who}`;
  const state = chat.archived ? "（已归档，群已解散）" : `，${chat.guestCount} 个访客，唤醒：${TRIGGER_TEXT[chat.triggerMode]}，访客：${TIER_TEXT[chat.guestTier]}`;
  return `  ${who}${state}`;
}

function statusText(status: FeishuStatusView): string {
  const lines = [`状态：${status.state}`];
  if (status.appId !== null) lines.push(`应用：${status.appId}（${status.brand === "lark" ? "Lark" : "飞书"}）${status.botName ? `，机器人：${status.botName}` : ""}`);
  if (status.appId !== null && status.hosting !== undefined) {
    lines.push(`角色：${status.hosting ? "中心（挂长连接）" : "非中心（入站由中心转发，出站本机直发）"}`);
  }
  if (status.ownerOpenId !== null) lines.push(`主人：${status.ownerName ?? status.ownerOpenId}`);
  if (status.missing.length > 0) lines.push(`缺权限：${status.missing.join("、")}（去飞书开发者后台开）`);
  if (status.lastError !== null) lines.push(`最近的错误：${status.lastError}`);
  if (status.chats.length > 0) lines.push("会话：", ...status.chats.map(chatLine));
  return `${lines.join("\n")}\n`;
}

export interface FeishuCliIo {
  argv: string[];
  stdin: () => Promise<string>;
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  /** 请求本机守护进程的管理 socket，回 JSON。连不上、回错误都抛错，message 是给人看的。 */
  admin(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<unknown>;
  /** 把链接画成终端里能扫的二维码（实现用已有依赖 qrcode-generator）。 */
  renderQr(url: string): string;
  /** 等扫码时两次查状态之间等多久（测试换成立刻返回）。 */
  sleep(ms: number): Promise<void>;
}

/** 后置：返回退出码：0 成功，1 守护进程报错、连不上或扫码被拒绝 / 过期，2 用法不对（打印用法）。 */
export async function runFeishuCli(io: FeishuCliIo): Promise<number> {
  try {
    return await dispatch(io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n\n${FEISHU_USAGE}`);
      return 2;
    }
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function parse(args: string[], options: ParseArgsOptionsConfig) {
  try {
    return parseArgs({ args, options: options ?? {}, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

async function dispatch(io: FeishuCliIo): Promise<number> {
  const [command, ...rest] = io.argv;
  switch (command) {
    case "connect": {
      const { values } = parse(rest, { manual: { type: "boolean" }, lark: { type: "boolean" } });
      return values.manual === true ? connectManual(io, values.lark === true) : connectByScan(io);
    }
    case "bind": {
      parse(rest, {});
      const code = (await io.admin("POST", "/feishu/bind-code")) as FeishuBindCodeResponse;
      io.stdout.write(`在飞书里私聊机器人，发这串数字（${Math.round((code.expiresAt - Date.now()) / 60_000)} 分钟内有效）：\n\n  ${code.code}\n`);
      return 0;
    }
    case "status":
      parse(rest, {});
      io.stdout.write(statusText((await io.admin("GET", "/feishu/status")) as FeishuStatusView));
      return 0;
    case "policy": {
      const { values, positionals } = parse(rest, { trigger: { type: "string" }, guest: { type: "string" } });
      const pmId = Number(positionals[0]);
      if (positionals.length !== 1 || !Number.isInteger(pmId) || pmId <= 0) throw new UsageError("要给一个项目经理编号");
      const trigger = values.trigger as string | undefined;
      const guest = values.guest as string | undefined;
      if (trigger === undefined && guest === undefined) throw new UsageError("--trigger 和 --guest 至少给一个");
      if (trigger !== undefined && !(FEISHU_TRIGGER_MODES as readonly string[]).includes(trigger)) throw new UsageError(`--trigger 只能是 ${FEISHU_TRIGGER_MODES.join("、")}`);
      if (guest !== undefined && !(FEISHU_GUEST_TIERS as readonly string[]).includes(guest)) throw new UsageError(`--guest 只能是 ${FEISHU_GUEST_TIERS.join("、")}`);
      const chat = (await io.admin("PUT", "/feishu/policy", { pmId, ...(trigger ? { triggerMode: trigger } : {}), ...(guest ? { guestTier: guest } : {}) })) as FeishuChatView;
      io.stdout.write(`${chatLine(chat).trim()}\n`);
      return 0;
    }
    case "resync":
      parse(rest, {});
      io.stdout.write(statusText((await io.admin("POST", "/feishu/resync")) as FeishuStatusView));
      return 0;
    case "disconnect": {
      const { values } = parse(rest, { "dissolve-chats": { type: "boolean" } });
      await io.admin("POST", "/feishu/disconnect", { dissolveChats: values["dissolve-chats"] === true });
      io.stdout.write(values["dissolve-chats"] === true ? "已断开，项目群已解散。\n" : "已断开，项目群留着。\n");
      return 0;
    }
    default:
      throw new UsageError(command === undefined ? "缺子命令" : `不认识的子命令：${command}`);
  }
}

async function connectByScan(io: FeishuCliIo): Promise<number> {
  let status = (await io.admin("POST", "/feishu/registration")) as FeishuStatusView;
  if (status.registration === null) {
    io.stderr.write(`没拿到二维码：${status.lastError ?? status.state}\n`);
    return 1;
  }
  io.stdout.write(`用手机飞书扫下面的二维码，确认后自动建好应用（${Math.round((status.registration.expiresAt - Date.now()) / 60_000)} 分钟内有效）：\n\n`);
  io.stdout.write(`${io.renderQr(status.registration.url)}\n${status.registration.url}\n`);
  while (status.state === "registering") {
    await io.sleep(FEISHU_CLI_POLL_MS);
    status = (await io.admin("GET", "/feishu/status")) as FeishuStatusView;
  }
  if (status.state === "unconfigured" || status.state === "auth_failed" || (status.appId === null && status.lastError !== null)) {
    io.stderr.write(`没接上：${status.lastError ?? status.state}\n`);
    return 1;
  }
  io.stdout.write(`已接上：${status.appId}${status.botName ? `（机器人：${status.botName}）` : ""}\n`);
  return 0;
}

async function connectManual(io: FeishuCliIo, lark: boolean): Promise<number> {
  io.stdout.write("依次输入 App ID 和 App Secret（各一行，从飞书开发者后台复制）：\n");
  const [appId = "", appSecret = ""] = (await io.stdin()).split(/\r?\n/).map((line) => line.trim());
  if (appId === "" || appSecret === "") throw new UsageError("要两行：App ID、App Secret");
  const status = (await io.admin("PUT", "/feishu/credentials", { brand: lark ? "lark" : "feishu", appId, appSecret })) as FeishuStatusView;
  io.stdout.write(`已接上：${status.appId ?? appId}，状态：${status.state}\n`);
  if (status.state === "awaiting_owner" || status.ownerOpenId === null) io.stdout.write("下一步：跑 bind 拿绑定码，在飞书里私聊机器人发它。\n");
  return 0;
}
