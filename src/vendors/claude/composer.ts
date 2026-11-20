import { COMMANDS_QUERY_TIMEOUT_MS } from "../../shared/index.ts";
import type { CommandsTarget, VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase, parseComposerCommands } from "../_common/composer.ts";
import type { ClaudeModelQueryOptions } from "./catalog.ts";

export const parseClaudeCommands = parseComposerCommands;

export const claudeComposerBase: VendorComposerBase = createSpecComposerBase("claude");

export interface ClaudeComposerOptions {
  executablePath: string | (() => string);
  queryInitialize: (options: ClaudeModelQueryOptions) => Promise<Record<string, unknown>>;
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  timeoutMs?: number;
}

export function createClaudeComposer(options: ClaudeComposerOptions): VendorComposer {
  return {
    ...claudeComposerBase,
    async queryCommands(target: CommandsTarget, signal: AbortSignal) {
      const claudePath = typeof options.executablePath === "function" ? options.executablePath() : options.executablePath;
      const env = typeof options.env === "function" ? options.env() : options.env;
      const response = await options.queryInitialize({
        claudePath,
        cwd: target.cwd,
        addDirs: target.addDirs,
        timeoutMs: options.timeoutMs ?? COMMANDS_QUERY_TIMEOUT_MS,
        signal,
        ...(env ? { env } : {}),
      });
      const commands = parseClaudeCommands(response.commands);
      if (commands === null) throw new Error("initialize 回应里没有 commands");
      return commands;
    },
  };
}

