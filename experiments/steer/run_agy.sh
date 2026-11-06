#!/bin/sh
# usage: run_agy.sh NAME   (scenario NAME.json -> out/NAME.jsonl). Runs in a fresh temp dir.
set -e
here=$(cd "$(dirname "$0")" && pwd)
name=$1; shift
tmp=$(mktemp -d /tmp/steer-agy-XXXXXX)
mkdir -p "$here/out"
cd "$tmp"
python3 "$here/steer_agy.py" "$here/$name.json" "$here/out/$name.jsonl" "$@"
python3 "$here/summarize_agy.py" "$here/out/$name.jsonl"
rm -rf "$tmp"
