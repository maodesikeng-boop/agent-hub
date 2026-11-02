#!/bin/sh
# Run the official `claude` CLI without inheriting the parent agent session's
# env (CLAUDECODE, session ids, ...), so experiments see a fresh top-level run.
exec env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT \
  -u CLAUDE_CODE_MAX_CONTEXT_TOKENS -u T3CODE_THREAD_ID -u T3CODE_CLI_PATH \
  claude "$@"
