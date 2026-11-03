// agent 接口（W2 实现，设计第 4.2、8.1、8.2 节）：agent 在自己的 shell 里敲 `hub ...`，hub 通过 Unix socket
// 请求守护进程，守护进程按会话令牌认人，交给账本的 hubCall。
//
// 请求：POST <hubPath(命令)>，头 `Authorization: Bearer <令牌>`，体是这个命令的参数 JSON（HubArgsMap）。
// 应答：HubResponse，HTTP 状态按 HUB_ERROR_HTTP_STATUS（成功 200）。
// 校验分两层：agent 接口按 JSON Schema 查形状和长度（缺参数、多余参数、超长 → invalid，不调账本）；
// 账本查业务（项目在不在、管不管得着、文件夹对不对）。
import type { ConversationId, PersonaChange, PmId, PmMode, Project, ProjectFolder, ProjectId, SessionId } from "./domain.ts";
// ledger.ts 只从这里引类型，没有运行时的循环引用
import { LEDGER_ERROR_HTTP_STATUS } from "./ledger.ts";
import type { LedgerErrorCode } from "./ledger.ts";

/** 会话令牌，hub 自己从环境变量读；agent 的命令里不能出现变量（M0 实测会被权限检查拒绝）。 */
export const ENV_HUB_TOKEN = "HUB_TOKEN";
/** hub.sock 的真实路径（realpath 过）。 */
export const ENV_HUB_SOCK = "HUB_SOCK";

/** 设置文件里放行 hub 的规则。 */
export const HUB_ALLOW_RULE = "Bash(hub:*)";

/**
 * 每个项目经理会话的 --settings 文件内容（设计第 7.2、8.2 节）。hubSockRealPath 必须是 realpath 过的
 * （macOS 上 /var 其实是 /private/var，写错了沙箱放行不生效）。
 */
export function buildHubSettings(hubSockRealPath: string) {
  return {
    permissions: { allow: [HUB_ALLOW_RULE] },
    sandbox: { network: { allowUnixSockets: [hubSockRealPath] } },
  };
}

/**
 * 命令（11-03 起一个项目经理只管一个项目，不再有项目群、交接）。命令行写法 → 命令名：
 * - `hub status`                                         → status：我是谁、我的项目和文件夹
 * - `hub project create --folder <路径> [--name <名>] [--description <说明>]` → project.create：给自己建项目（只能有一个）
 * - `hub project attach <文件夹>`                         → project.attach：给自己的项目挂上附加文件夹
 * - `hub project detach <文件夹>`                         → project.detach：从自己的项目上移除附加文件夹
 * - `hub persona show`                                   → persona.show
 * - `hub persona edit [--mode <模式>] [--reason <理由>] [--stdin | --text <正文>]` → persona.edit，新全文；可以只改模式
 *
 * hub 命令行的约定：
 * - 项目不用点名：每个项目经理只有一个，账本按会话找；
 * - 路径参数里开头的 `~` 由 hub 展开成 HOME，相对路径按 hub 的当前目录变成绝对路径，再发出去；账本还会 resolveFolder 一次；
 * - 长文本：只有显式写了 `--stdin` 才读标准输入（读到结束，去掉末尾一个换行），没写就绝不碰标准输入
 *   （agent 的 shell 里标准输入可能一直开着，“没带正文就去读”会卡住）。不用 `--text -` 这种写法。
 *   提示词里教 `hub persona edit --stdin <<'EOF'`。
 *   --stdin 和 --text 同时给 → 用法不对，退出码 2；persona.edit 没有正文也没有 --mode（或读到空的）→ 用法不对。
 */
export const HUB_COMMANDS = ["status", "project.create", "project.attach", "project.detach", "persona.show", "persona.edit"] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

export function hubPath(command: HubCommand): string {
  return `/v1/${command}`;
}

/** 各命令的请求体。字符串长度上限见 limits.ts；路径都是绝对路径。 */
export interface HubArgsMap {
  status: Record<string, never>;
  /** name 不给就用主文件夹的名字。 */
  "project.create": { folder: string; name?: string; description?: string };
  "project.attach": { folder: string };
  "project.detach": { folder: string };
  "persona.show": Record<string, never>;
  /** text：新的完整性格设定（不超过 MAX_PERSONA_BYTES）。text、mode 至少给一个。 */
  "persona.edit": { text?: string; mode?: PmMode; reason?: string };
}

export type HubArgs<C extends HubCommand> = HubArgsMap[C];

/** 项目名片：提示词、hub status 里用。 */
export interface ProjectCard {
  id: ProjectId;
  name: string;
  description: string | null;
  /** 主文件夹的真实路径。 */
  mainFolder: string;
  /** 其他没移除的文件夹。 */
  otherFolders: string[];
}

/** 各命令成功时的 data。text 是给 agent 看的一两句中文，data 给程序用。 */
export interface HubDataMap {
  status: {
    pm: { id: PmId; name: string; mode: PmMode };
    sessionId: SessionId;
    /** 项目经理的那个对话。 */
    conversationId: ConversationId;
    /** 它的项目；还没有是 null。 */
    project: ProjectCard | null;
  };
  "project.create": { project: Project; mainFolder: ProjectFolder };
  "project.attach": { project: Project; folder: ProjectFolder };
  "project.detach": { project: Project; folder: ProjectFolder };
  "persona.show": { text: string; mode: PmMode };
  /** change 为 null：内容和模式都没变，什么也没记。 */
  "persona.edit": { change: PersonaChange | null };
}

export type HubData<C extends HubCommand> = HubDataMap[C];

export interface HubResult<C extends HubCommand> {
  text: string;
  data: HubData<C>;
}

/**
 * 错误码：账本的四种（LedgerRequestError）加两种只有 agent 接口有的：
 * - unauthorized：没带令牌、令牌不对或已作废（401），不调账本；
 * - internal：守护进程自己出错（500），message 是错误原文。
 * 请求体不对（未知命令、缺参数、超长）是 invalid（400）。整个请求体超过 HUB_MAX_BODY_BYTES 也是 invalid、400
 * （W2 把 Fastify 的 FST_ERR_CTP_BODY_TOO_LARGE 改写成 { ok: false, code: "invalid" }），不用 413，hub 只认这张表里的状态。
 */
export type HubErrorCode = LedgerErrorCode | "unauthorized" | "internal";

export const HUB_ERROR_HTTP_STATUS: Readonly<Record<HubErrorCode, number>> = {
  ...LEDGER_ERROR_HTTP_STATUS,
  unauthorized: 401,
  internal: 500,
};

/** 应答体。message 是给 agent 看的一句中文，hub 原样打印。 */
export type HubResponse<C extends HubCommand = HubCommand> =
  | { ok: true; text: string; data: HubData<C> }
  | { ok: false; code: HubErrorCode; message: string };

/**
 * hub 的退出码：
 * - ok：成功，打印 text；
 * - rejected：系统拒绝（任何 ok: false 的应答，包括 unauthorized、internal），打印 message；
 * - usage：用法不对（未知子命令、缺参数、没设 HUB_TOKEN 或 HUB_SOCK），打印用法；
 * - unreachable：连不上守护进程（socket 不存在、拒绝连接、超时），打印“连不上 agent-hub，守护进程可能没在跑”。
 */
export const HUB_EXIT = { ok: 0, rejected: 1, usage: 2, unreachable: 3 } as const;

/** 会话令牌：32 字节随机数，base64url。 */
export const HUB_TOKEN_BYTES = 32;

/**
 * 会话令牌（W2 实现，只在内存里，盘上不落；守护进程重启后全部作废）。
 * - issue：这个会话已经有有效令牌就返回同一个，没有才生成新的。prepareLaunch 会被反复调（见 driver.ts），
 *   每次都换新令牌的话，正在跑的进程手里的令牌就失效了。revoke 过的会话再调 issue 直接抛错（不再发新令牌）；
 *   已结束（status ended）的会话不会走到 issue：驱动层对它的 start、send 先抛 session_ended，prepareLaunch 不会被调；
 * - resolve：令牌 → 会话，不认识或已作废返回 null。用定长比较；
 * - revoke：作废这个会话的令牌，并记住这个会话已作废。组装代码在 session.end 处理完（会话 ended）时调。
 */
export interface SessionTokens {
  issue(sessionId: SessionId): string;
  resolve(token: string): SessionId | null;
  revoke(sessionId: SessionId): void;
}

/** revoke 过的会话再 issue 抛这个。组装代码只把它当“会话已结束”，issue 的其他错照常抛出。 */
export class SessionTokenRevokedError extends Error {
  constructor(sessionId: SessionId) {
    super(`session ${sessionId} token was revoked; no new token is issued`);
    this.name = "SessionTokenRevokedError";
  }
}
