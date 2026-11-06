#!/bin/sh
# usage: run.sh NAME   (scenario NAME.json -> out/NAME.jsonl). Runs in a fresh temp dir.
set -e
here=$(cd "$(dirname "$0")" && pwd)
name=$1; shift
tmp=$(mktemp -d /tmp/steer-XXXXXX)
mkdir -p "$here/out"
echo "You are a test agent. Follow the user's instructions exactly and concisely. ${PROMPT_EXTRA:-}" > "$tmp/prompt.txt"
sid=$(uuidgen | tr A-Z a-z)
cd "$tmp"
python3 "$here/steer.py" "$here/$name.json" "$here/out/$name.jsonl" -- \
  -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages \
  --session-id "$sid" --model haiku --no-session-persistence --strict-mcp-config \
  --allowedTools Bash --append-system-prompt-file "$tmp/prompt.txt" "$@"
python3 "$here/summarize.py" "$here/out/$name.jsonl"
rm -rf "$tmp"
