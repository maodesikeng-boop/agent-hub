#!/bin/sh
label=$1; shift
cd /tmp/ro110/ws && rm -f /tmp/ro110/outside/mcp-w.txt /tmp/ro110/mcp/calls.log
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT \
  -u CLAUDE_CODE_MAX_CONTEXT_TOKENS -u HUB_TOKEN -u HUB_SOCK -u ENABLE_TOOL_SEARCH \
  perl -e "alarm 300; exec @ARGV" claude -p "$(cat /tmp/ro110/prompt-mcp.txt)" --output-format stream-json --verbose --no-session-persistence \
  --model sonnet --effort low --mcp-config /tmp/ro110/mcp/claude-mcp.json --strict-mcp-config "$@" > /tmp/ro110/out-$label.jsonl 2>/tmp/ro110/err-$label.txt </dev/null
echo "exit=$?"; echo "calls:"; grep CALL /tmp/ro110/mcp/calls.log; ls /tmp/ro110/outside/mcp-w.txt 2>/dev/null
