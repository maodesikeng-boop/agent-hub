// 输入框的 commands、files 接口背后的东西（界面服务调它，网页不传路径、不认识厂商）：
// 按对话从账本找到它最新一代的会话、厂商和目录（Ledger.composerTarget），命令列表交给 commands-catalog.ts，
// 文件交给 workspace-files.ts，插进输入框的写法交给厂商实现（vendors/）。
import { isAbsolute, join } from "node:path";
import type { CommandsResponse, ConversationId, FilesResponse, Ledger } from "../shared/index.ts";
import type { CommandCatalogs } from "./commands-catalog.ts";
import { composerBaseOf } from "./vendors/index.ts";
import type { WorkspaceFiles } from "./workspace-files.ts";

export interface ComposerService {
  commands(conversationId: ConversationId): Promise<CommandsResponse>;
  files(conversationId: ConversationId, query: string): Promise<FilesResponse>;
}

export interface ComposerServiceOptions {
  ledger: Pick<Ledger, "composerTarget">;
  commands: Pick<CommandCatalogs, "list">;
  files: WorkspaceFiles;
}

export function createComposerService(options: ComposerServiceOptions): ComposerService {
  return {
    async commands(conversationId) {
      const target = options.ledger.composerTarget(conversationId);
      return { commands: await options.commands.list(target) };
    },
    async files(conversationId, query) {
      const target = options.ledger.composerTarget(conversationId);
      const vendor = composerBaseOf(target.vendor);
      const roots = target.fileRoots.filter((r) => isAbsolute(r));
      if (vendor === null || roots.length === 0) return { entries: [], truncated: false };
      const main = roots[0];
      const { matches, truncated } = await options.files.search(roots, query);
      return {
        // 主文件夹（agent 的工作目录）里的插相对路径，别的文件夹里的插绝对路径
        entries: matches.map((m) => ({ path: m.path, root: m.root, insert: vendor.mention(m.root === main ? m.path : join(m.root, m.path)) })),
        truncated,
      };
    },
  };
}
