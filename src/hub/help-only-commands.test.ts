import { describe, expect, it } from "vitest";
import { HUB_USAGE_PROMPT } from "../daemon/prompt.ts";
import { HUB_COMMANDS, HUB_HELP_ONLY_COMMANDS, type HubHelpOnlyCommand } from "../shared/hub.ts";
import { HUB_COMMAND } from "../shared/names.ts";
import { parseCommand } from "./parse.ts";
import { HUB_COMMAND_SPECS, HUB_USAGE } from "./usage.ts";

describe("help-only hub commands (prompt cache safety + discoverability)", () => {
  const helpOnlyCommands = Object.keys(HUB_HELP_ONLY_COMMANDS) as HubHelpOnlyCommand[];

  it("regression: none of HUB_HELP_ONLY_COMMANDS appears in HUB_USAGE_PROMPT", () => {
    expect(helpOnlyCommands.length).toBeGreaterThan(0);
    for (const command of helpOnlyCommands) {
      expect(HUB_COMMANDS).toContain(command);
      expect(HUB_USAGE_PROMPT, command).not.toContain(`${HUB_COMMAND} ${command.replace(".", " ")}`);
    }
  });

  it("every command in HUB_HELP_ONLY_COMMANDS has an entry in HUB_COMMAND_SPECS and HUB_USAGE", () => {
    const specCommands = new Set(HUB_COMMAND_SPECS.map((s) => s.command));
    for (const command of helpOnlyCommands) {
      expect(specCommands.has(command), `missing HUB_COMMAND_SPECS entry for ${command}`).toBe(true);
      expect(HUB_USAGE, `missing HUB_USAGE text for ${command}`).toContain(`${HUB_COMMAND} ${command.replace(".", " ")}`);
    }
  });

  it("CLI parses ask list, ask show, and schedule show", () => {
    expect(parseCommand(["ask", "list"], {}, "/tmp")).toEqual({
      command: "ask.list",
      body: {},
      textSource: null,
    });
    expect(parseCommand(["ask", "show", "222"], {}, "/tmp")).toEqual({
      command: "ask.show",
      body: { itemId: 222 },
      textSource: null,
    });
    expect(parseCommand(["ask", "show", "--message", "99"], {}, "/tmp")).toEqual({
      command: "ask.show",
      body: { messageId: 99 },
      textSource: null,
    });
    expect(parseCommand(["schedule", "show", "6"], {}, "/tmp")).toEqual({
      command: "schedule.show",
      body: { scheduleId: 6 },
      textSource: null,
    });
  });
});
