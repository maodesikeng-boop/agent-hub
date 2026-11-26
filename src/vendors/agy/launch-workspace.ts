import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSyncWithRetry } from "../../daemon/platform/index.ts";
import { AGY_RULES_WORKSPACE_DIR, writeAgyPromptRules } from "./rules.ts";

function scheduleGuardCommand(): string {
  const reply = JSON.stringify({
    decision: "deny",
    reason: "Built-in timers are disabled in Bellwood. Use hub schedule for scheduled work.",
  });
  return process.platform === "win32" ? `echo ${reply}` : `printf '%s\\n' '${reply}'`;
}

export function prepareAgyLaunchWorkspace(promptFile: string, skillsDir?: string): string {
  const workspace = writeAgyPromptRules(promptFile, skillsDir) ?? join(dirname(promptFile), AGY_RULES_WORKSPACE_DIR);
  const agentsDir = join(workspace, ".agents");
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  // The headless stream does not finish the turn while a built-in timer is pending.
  const hooks = {
    "bellwood-schedule": {
      PreToolUse: [{ matcher: "^schedule$", hooks: [{ type: "command", command: scheduleGuardCommand() }] }],
    },
  };
  writeFileAtomicSyncWithRetry(join(agentsDir, "hooks.json"), JSON.stringify(hooks), { mode: 0o600 });
  return workspace;
}
