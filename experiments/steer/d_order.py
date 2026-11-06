#!/usr/bin/env python3
"""D 场景：没赶上这一轮的消息（第二条），第一个 result 和 command_lifecycle started(第二条) 谁先到。usage: d_order.py OUT.jsonl..."""
import json, sys

B = "00000000-0000-4000-8000-000000000002"
for path in sys.argv[1:]:
    seq = []
    for line in open(path):
        r = json.loads(line)
        j = r.get("json") or {}
        if r["kind"] == "write" and r["line"].get("uuid") == B:
            seq.append(f"{r['dt']} write(B)")
        elif j.get("type") == "result":
            seq.append(f"{r['dt']} result")
        elif j.get("type") == "command_lifecycle":
            who = "B" if j.get("command_uuid") == B else "A"
            seq.append(f"{r['dt']} {j.get('state')}({who})")
    firsts = [s.split(" ", 1)[1] for s in seq]
    order = "started(B) 先于第一个 result" if "started(B)" in firsts and "result" in firsts and firsts.index("started(B)") < firsts.index("result") else "result 先于 started(B)"
    print(f"{path}: {order}\n  " + " | ".join(seq))
