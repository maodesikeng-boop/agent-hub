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
        entries: matches.map((m) => ({ path: m.path, root: m.root, insert: vendor.mention(m.root === main ? m.path : join(m.root, m.path)) })),
        truncated,
      };
    },
  };
}
