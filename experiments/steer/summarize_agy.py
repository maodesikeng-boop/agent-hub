#!/usr/bin/env python3
"""Print a compact timeline of an agy steer run: summarize_agy.py out/NAME.jsonl"""
import json, sys

for line in open(sys.argv[1]):
    r = json.loads(line)
    dt, kind = r["dt"], r["kind"]
    if kind == "write":
        c = r["line"].get("message", {}).get("content", [])
        print(f"{dt:7.2f} WRITE      {' | '.join(b.get('text', '')[:90] for b in c)}")
    elif kind == "stderr":
        print(f"{dt:7.2f} stderr     {r.get('text', '')[:120]}")
    elif kind == "driver":
        if "note" in r or "exit_code" in r:
            print(f"{dt:7.2f} driver     {r.get('note') or 'exit_code=' + str(r['exit_code'])}")
    elif kind == "stdout":
        j = r["json"]; e = j.get("event")
        if e == "step_update":
            su = j["step_update"]; st = su.get("step_type"); state = su.get("state")
            extra = ""
            if st == "tool":
                extra = f" {su.get('tool_name')} {json.dumps(su.get('tool_info', {}).get('parameters', {}), ensure_ascii=False)[:80]}"
                if state == "DONE":
                    extra += f" out={su.get('tool_info', {}).get('output', '')[:40]!r}"
            elif st == "agent_response":
                extra = f" delta={su.get('text_delta', su.get('text', ''))[:80]!r}"
            print(f"{dt:7.2f} step#{su.get('step_index')} {st}/{state}{extra}")
        elif e == "result":
            res = j["result"]
            print(f"{dt:7.2f} RESULT     {res.get('status')} turns={res.get('num_turns')} response={res.get('response', '')[:100]!r}")
        else:
            print(f"{dt:7.2f} {e}")
