import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomicSyncWithRetry } from "../../daemon/platform/index.ts";
import { AGY_RULES_WORKSPACE_DIR, writeAgyPromptRules } from "./rules.ts";

export function denyHookCommand(reason: string, platform: NodeJS.Platform = process.platform): string {
  const reply = JSON.stringify({ decision: "deny", reason });
  if (platform === "win32") return `echo ${reply}`;
  return `printf '%s\\n' '${reply.replaceAll("'", "'\\''")}'`;
}

export function defaultAgyScheduleHooks(platform: NodeJS.Platform = process.platform): Record<string, unknown> {
  // The headless stream does not finish the turn while a built-in timer is pending.
  return {
    "bellwood-schedule": {
      PreToolUse: [
        {
          matcher: "^schedule$",
          hooks: [
            {
              type: "command",
              command: denyHookCommand("Built-in timers are disabled in Bellwood. Use hub schedule for scheduled work.", platform),
            },
          ],
        },
      ],
    },
  };
}

export function prepareAgyLaunchWorkspace(
  promptFile: string,
  skillsDir?: string,
  hooks: Record<string, unknown> = defaultAgyScheduleHooks(),
): string {
  const workspace = writeAgyPromptRules(promptFile, skillsDir) ?? join(dirname(promptFile), AGY_RULES_WORKSPACE_DIR);
  const agentsDir = join(workspace, ".agents");
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  writeFileAtomicSyncWithRetry(join(agentsDir, "hooks.json"), JSON.stringify(hooks), { mode: 0o600 });
  return workspace;
}
