#!/bin/sh
# Usage: triage.sh OUTDIR   — classify each line of triage_messages.txt with a
# cheap model + --json-schema (one-shot, no tools, no session), in parallel.
here=$(cd "$(dirname "$0")" && pwd); out=$1; mkdir -p "$out"
schema=$(cat "$here/triage_schema.json")
i=0
while IFS= read -r msg; do
  i=$((i+1))
  ( { cat "$here/triage_context.txt"; printf '%s\n' "$msg"; } | \
    "$here/claude_clean.sh" -p --output-format json --json-schema "$schema" \
      --tools "" --no-session-persistence --model "${MODEL:-claude-haiku-5-5}" \
      --strict-mcp-config > "$out/t$i.json" 2> "$out/t$i.err" ) &
done < "$here/triage_messages.txt"
wait
