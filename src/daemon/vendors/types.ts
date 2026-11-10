// 厂商接口：输入框的“/”命令和“@”文件里跟厂商有关的部分。网页只认通用接口（shared/api.ts 的 ComposerCommand、FileEntry），
// 不认识哪家厂商；后台按对话的会话那一行的 vendor 找到实现（vendors/index.ts）。
// 纯数据（隐藏名单、拦下时的原因、命令开头的字符）在各家 spec.ts 的 composer；接口在这里，各家的实现在 src/vendors/<厂商>/composer.ts。
// 加一家厂商要动的地方见 docs/vendor-plugin-design.md 第 8 节。
import type { AgentVendor, ComposerCommand, ModelCatalog, VendorAvailability } from "../../shared/index.ts";

/** 在哪儿问命令列表：会话的工作目录和附加文件夹（项目里的命令、skill 跟着目录走）。 */
export interface CommandsTarget {
  cwd: string;
  addDirs: readonly string[];
}

/** 不用起进程的那部分（驱动层拼消息、账本拦命令、网页要“@”的写法都只用它，不连带起进程的代码）。 */
export interface VendorComposerBase {
  readonly vendor: AgentVendor;
  /** 厂商回的命令列表（initialize 回应、commands_changed 里的）→ 通用形状；整个认不出（不是数组）返回 null。 */
  parseCommands(raw: unknown): ComposerCommand[] | null;
  /** 这个命令要不要从列表里藏起来：只藏厂商自带的（builtin）、又在隐藏名单里的；用户自己的命令、skill 重名也留着。 */
  isHiddenCommand(command: ComposerCommand): boolean;
  /** 用户原文是不是压缩上下文的命令（claude 的 /compact，带不带说明都算）：这一轮只压缩、不回话。 */
  isCompactCommand(text: string): boolean;
  /** 用户原文是不是命令：是的话单独写进去，不和别的用户消息拼在一起。 */
  isCommand(text: string): boolean;
  /**
   * 用户发的这句要不要拦下不发（隐藏的命令）；拦就返回给人看的原因，不拦返回 null。
   * known 是缓存着的这个会话的命令列表（没问到过是 null）：名字在里面、而且是用户自己的（不是 builtin）就放行；
   * 没有缓存、列表里没有这个名字（别名）时按名字拦，宁可保守。
   */
  blockReason(text: string, known: readonly ComposerCommand[] | null): string | null;
  /** 选中的文件插进输入框的文字（不含末尾空格）。path 是相对 agent 工作目录的路径，或者绝对路径。 */
  mention(path: string): string;
  /**
   * 一条用户消息写给 agent 的 content：prefixes 是我们加的字（说明、标签、“【用户连发了 N 条】”），text 是用户原文。
   * 原文要能被 agent 当命令认出来（claude：原文单独放最后一个 text 块）。
   */
  buildUserContent(prefixes: readonly string[], text: string): unknown[];
}

export interface VendorComposer extends VendorComposerBase {
  /**
   * 会话没在跑时另起一个 agent 进程问命令列表（正在跑的会话由驱动层的 Driver.queryCommands 问，不走这里）。
   * 返回通用形状，没去掉隐藏的；问不到（没装、超时、报错、回的认不出）Promise 失败，带原因。
   */
  queryCommands(target: CommandsTarget, signal: AbortSignal): Promise<ComposerCommand[]>;
}

/**
 * 模型名单那次查询里怎么看这家（纯函数，不起进程）：解析名单、看这台设备上登没登录（docs/vendor-availability-design.md 第 3 节）。
 * 起进程问的部分在各家的 create<厂商>CatalogSource。
 */
export interface VendorCatalogProbe {
  /** 回应 → 名单；认不出是 null（用打包的）。 */
  parse(raw: unknown): ModelCatalog | null;
  /** 问到了：同一次回应里的登录状态，看不出是 unknown。 */
  availabilityOf(raw: unknown): VendorAvailability;
  /** 没问到：从错误看。不写按通用的认（model-catalog.ts 的 defaultAvailabilityOfError）。 */
  availabilityOfError?(error: unknown): VendorAvailability;
}

/** 起进程问名单要的东西（守护进程给）。 */
export interface VendorCatalogSourceOptions {
  /** 可执行文件（resolveExecutable 解析过的）。 */
  path: string;
  /** 在哪个目录问：用户主目录（codex 也从这里找 ~/.codex）。 */
  cwd: string;
  /** 装没装（findExecutable，只查文件）。 */
  installed: () => boolean;
  /** 可执行文件及本地凭据/模型缓存文件的轻量 stat 指纹。 */
  fingerprint?: () => string;
  env?: NodeJS.ProcessEnv;
}
