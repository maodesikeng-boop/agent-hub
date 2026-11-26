# Progress checklist fixtures

Frames that drive the checklist and action timing tests. Each probe ran in a throwaway home and working directory, read one `probe.txt`, and kept only progress-related lines; no credentials are included.

| File | Vendor and source |
| --- | --- |
| `claude-turn-1.live.jsonl`, `claude-turn-2.live.jsonl` | One Claude Code session with six tasks. The second turn adds tasks 4–6. |
| `codex-turn-1.live.jsonl`, `codex-turn-2.live.jsonl` | One Codex app-server thread. The second turn repeats three completed steps and adds three new ones. |
| `cursor-turn-1.live.jsonl`, `cursor-turn-2.live.jsonl` | One Cursor ACP session. The second turn merges new items into the first turn’s list. |
| `claude-task-tools.live.jsonl` | Claude Code 2.1.330 with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`: `TaskCreate`, `TaskUpdate`, a file read, top-level `tool_use_result`, and the turn result |
| `claude-todowrite.live.jsonl` | Same version with `TodoWrite`: three whole lists and `oldTodos`/`newTodos` |
| `codex-plan.live.jsonl` | Codex 0.169.0 with `tools.update_plan.enabled=true`: three `turn/plan/updated` notifications and turn timing |
| `codex-default.live.jsonl` | Same version with default config: no plan, `agentMessage` timing only |
| `cursor-todo.live.jsonl` | cursor-agent 2026.11.10: three `cursor/update_todos` requests with JSON-RPC ids and the matching ACP tool frames |
| `cursor-create-plan.live.jsonl` | Same version in plan mode: the `cursor/create_plan` approval request, which this feature must not change |
| `opencode-todo.live.jsonl` | OpenCode 2.4.1 with `OPENCODE_FLAGS=todo`: `todowrite` frames, empty first `rawInput`, and `rawOutput.metadata.todos` |
| `opencode-default.live.jsonl` | Same version with default flags: a file read, no todo tool |
| `pi-tools.live.jsonl` | Pi 1.5.2 RPC: `tool_execution_start` and `tool_execution_end` with `durationMs` |
| `agy-tool.done.docs-capture.json` | Antigravity `step_update` frame published in the vendor's headless documentation |
| `deepseek-todo.source-derived.json` | DeepSeek Harness 0.2.2-rc.1 ACP `todo_write` frame built from that version's source |
| `kimi-plan.source-derived.json` | Kimi Code CLI 2.7.3 ACP `plan` update built from the published package |
| `kimi-tool.source-derived.json` | Same version's `TodoList` tool frame built from the published package |

`live` files are real CLI output. `docs-capture` and `source-derived` files were not captured on this machine; the vendors' authentication blocked a live turn.

The two-turn recordings use literal markers and no project files. The pipeline also replays an adapted second turn for OpenCode, DeepSeek, and Kimi. Those three were not run live for this change. Agy and Pi send no checklist events.
