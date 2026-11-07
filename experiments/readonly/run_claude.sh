#!/bin/sh
# usage: run_claude.sh <label> <settings.json> [extra args...]
label=$1; settings=$2; shift 2
cd /tmp/ro110/ws && rm -f /tmp/ro110/ws/w*.txt /tmp/ro110/outside/w*.txt
start=$(python3 -c 'import time;print(int(time.time()*1000))')
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
  -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_PID \
  -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_AGENT_SDK_VERSION -u CLAUDE_CODE_EXECPATH -u CLAUDE_EFFORT \
  -u CLAUDE_CODE_MAX_CONTEXT_TOKENS -u HUB_TOKEN -u HUB_SOCK \
  perl -e "alarm 300; exec @ARGV" claude -p "$(cat /tmp/ro110/prompt.txt)" --output-format stream-json --verbose --no-session-persistence \
  --model sonnet --effort low --settings "$settings" "$@" > /tmp/ro110/out-$label.jsonl 2>/tmp/ro110/err-$label.txt </dev/null
echo "exit=$? ms=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - start ))"
echo "written:"; ls /tmp/ro110/ws/w*.txt /tmp/ro110/outside/w*.txt 2>/dev/null
