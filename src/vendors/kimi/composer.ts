import type { ComposerCommand } from "../../shared/index.ts";
import type { VendorComposer, VendorComposerBase } from "../../daemon/vendors/types.ts";
import { createSpecComposerBase } from "../_common/composer.ts";

// Built-in ACP commands from kimi acp; skills arrive later through available_commands_update.
export const KIMI_BUILTIN_COMMANDS: readonly ComposerCommand[] = [
  { name: "compact", description: "压缩当前对话上下文", argumentHint: "<可选的总结要求>", builtin: true },
  { name: "status", description: "查看当前会话状态", builtin: true },
  { name: "usage", description: "查看本会话的 Token 用量", builtin: true },
  { name: "tasks", description: "列出后台任务", builtin: true },
];

export const kimiComposerBase: VendorComposerBase = createSpecComposerBase("kimi");

export function createKimiComposer(): VendorComposer {
  return {
    ...kimiComposerBase,
    async queryCommands(_target, signal) {
      if (signal.aborted) throw new Error("kimi commands query aborted");
      return [...KIMI_BUILTIN_COMMANDS];
    },
  };
}
