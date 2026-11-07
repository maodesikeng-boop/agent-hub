#!/bin/sh
# usage: run_codex.sh <label> <promptfile> [extra args...]
label=$1; pf=$2; shift 2
cd /tmp/ro110/ws && rm -f /tmp/ro110/ws/w*.txt /tmp/ro110/outside/w*.txt /tmp/ro110/outside/mcp-w.txt /tmp/ro110/mcp/calls.log
C=/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
s=$(python3 -c 'import time;print(int(time.time()*1000))')
env -u HUB_TOKEN -u HUB_SOCK perl -e 'alarm 300; exec @ARGV' $C exec --ephemeral --json --skip-git-repo-check -m gpt-5.6-luna -c 'service_tier="default"' -c 'model_reasoning_effort="low"' \
  -c 'mcp_servers.rotest.command="node"' -c 'mcp_servers.rotest.args=["/tmp/ro110/mcp/server.mjs"]' "$@" "$(cat /tmp/ro110/$pf)" > /tmp/ro110/out-$label.jsonl 2>/tmp/ro110/err-$label.txt </dev/null
echo "exit=$? ms=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - s ))"
echo written:; ls /tmp/ro110/ws/ /tmp/ro110/outside/ | grep -E "^w|mcp-w"; grep CALL /tmp/ro110/mcp/calls.log
python3 - "$label" <<'PY'
import json,sys
for l in open(f'/tmp/ro110/out-{sys.argv[1]}.jsonl'):
    try:o=json.loads(l)
    except: continue
    it=o.get('item') or {}
    if o.get('type')=='turn.failed': print('FAILED',str(o)[:300])
    if o.get('type')=='item.completed':
        t=it.get('type')
        if t=='agent_message': print('MSG:',it.get('text','')[:2500])
        elif t=='command_execution': print(' cmd',it.get('status'),it.get('exit_code'),it.get('command')[:100],'|',(it.get('aggregated_output') or '')[:100].replace('\n',' '))
        elif t=='error': pass
        else: print(' ',t,json.dumps(it,ensure_ascii=False)[:250])
PY
