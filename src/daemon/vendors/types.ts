// 厂商接口：输入框的“/”命令和“@”文件里跟厂商有关的部分。网页只认通用接口（shared/api.ts 的 ComposerCommand、FileEntry），
// 不认识哪家厂商；后台按对话的会话那一行的 vendor 找到实现（vendors/index.ts）。
// 纯数据（隐藏名单、拦下时的原因、命令开头的字符）在 shared/vendors.ts 的 VENDOR_SPECS[vendor].composer；要写代码的在这里。
// 加一家厂商：在 shared/vendors.ts 加它的清单（含 composer），平级加一个 <厂商>.ts 实现 VendorComposer，在 index.ts 登记。
import type { AgentVendor, ComposerCommand } from "../../shared/index.ts";

/** 在哪儿问命令列表：会话的工作目录和附加文件夹（项目里的命令、skill 跟着目录走）。 */
export interface CommandsTarget {
  cwd: string;
  addDirs: readonly string[];
}

export interface VendorComposer {
  readonly vendor: AgentVendor;
  /**
   * 会话没在跑时另起一个 agent 进程问命令列表（正在跑的会话由驱动层的 Driver.queryCommands 问，不走这里）。
   * 返回通用形状，没去掉隐藏的；问不到（没装、超时、报错、回的认不出）Promise 失败，带原因。
   */
  queryCommands(target: CommandsTarget, signal: AbortSignal): Promise<ComposerCommand[]>;
  /** 厂商回的命令列表（initialize 回应、commands_changed 里的）→ 通用形状；整个认不出（不是数组）返回 null。 */
  parseCommands(raw: unknown): ComposerCommand[] | null;
  /** 这个命令（不带开头的 /）要不要从列表里藏起来。 */
  isHiddenCommand(name: string): boolean;
  /** 用户原文是不是命令：是的话单独写进去，不和别的用户消息拼在一起。 */
  isCommand(text: string): boolean;
  /** 用户发的这句要不要拦下不发（隐藏的命令）；拦就返回给人看的原因，不拦返回 null。 */
  blockReason(text: string): string | null;
  /** 选中的文件插进输入框的文字（不含末尾空格）。path 是相对 agent 工作目录的路径，或者绝对路径。 */
  mention(path: string): string;
  /**
   * 一条用户消息写给 agent 的 content：prefixes 是我们加的字（说明、标签、“【用户连发了 N 条】”），text 是用户原文。
   * 原文要能被 agent 当命令认出来（claude：原文单独放最后一个 text 块）。
   */
  buildUserContent(prefixes: readonly string[], text: string): unknown[];
}
