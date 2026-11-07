#!/bin/sh
# usage: run_agy.sh <label> <promptfile> [extra args...]
label=$1; pf=$2; shift 2
cd /tmp/ro110/ws && rm -f /tmp/ro110/ws/w*.txt /tmp/ro110/outside/w*.txt /tmp/ro110/outside/mcp-w.txt /tmp/ro110/mcp/calls.log
start=$(python3 -c 'import time;print(int(time.time()*1000))')
env -u HUB_TOKEN -u HUB_SOCK perl -e "alarm 300; exec @ARGV" agy --output-format stream-json --print-timeout 240s "$@" --print "$(cat /tmp/ro110/$pf)" > /tmp/ro110/out-$label.jsonl 2>/tmp/ro110/err-$label.txt </dev/null
echo "exit=$? ms=$(( $(python3 -c 'import time;print(int(time.time()*1000))') - start ))"
echo "written:"; ls /tmp/ro110/ws/w*.txt /tmp/ro110/outside/w*.txt /tmp/ro110/outside/mcp-w.txt 2>/dev/null; grep CALL /tmp/ro110/mcp/calls.log 2>/dev/null
