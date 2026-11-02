#!/bin/sh
# Usage: run_connect.sh WORKDIR PROMPT_FILE OUT.jsonl [extra claude args...]
# Asks claude (haiku) to curl the fake daemon over TCP and over a Unix socket
# from its Bash tool, with HUB_TOKEN set in its environment.
here=$(cd "$(dirname "$0")" && pwd)
work=$1; prompt=$2; out=$3; shift 3
scen=$(mktemp)
python3 -c 'import json,sys; print(json.dumps([{"send": open(sys.argv[1]).read()}, {"wait": "result", "timeout": 180}, {"close": True}, {"exit": 30}]))' "$prompt" > "$scen"
cd "$work" && PATH="$here/bin:$PATH" HUB_TCP=127.0.0.1:47815 HUB_SOCK="${HUB_SOCK:-}" HUB_TOKEN=tok-conn-test python3 "$here/drive.py" "$scen" "$out" -- \
  -p --input-format stream-json --output-format stream-json --verbose \
  --model claude-haiku-5-5 --strict-mcp-config --tools Bash "$@"
rm -f "$scen"
