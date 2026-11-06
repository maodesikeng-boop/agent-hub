#!/usr/bin/env python3
"""One line per interesting event: dt kind type detail."""
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line); dt = r["dt"]; k = r["kind"]
    if k == "driver":
        if "step" in r: print(f"{dt:6.2f} STEP   {json.dumps(r['step'], ensure_ascii=False)[:150]}")
        elif "note" in r or "exit_code" in r: print(f"{dt:6.2f} DRIVER {r}")
        continue
    if k == "stderr": print(f"{dt:6.2f} STDERR {r.get('text') or r.get('json')}"); continue
    if k == "write":
        j = r["line"]; c = j.get("message", {}).get("content")
        txt = c if isinstance(c, str) else " | ".join(b.get("text", "") for b in c) if c else json.dumps(j)
        extra = {x: j[x] for x in ("priority", "origin", "uuid") if x in j}
        print(f"{dt:6.2f} WRITE  {txt[:90]} {extra or ''}"); continue
    j = r.get("json") or {}; t = j.get("type"); st = j.get("subtype")
    if t == "stream_event":
        continue
    d = ""
    if t == "assistant":
        for b in j["message"]["content"]:
            if b["type"] == "text": d += f" text:{b['text'][:90]!r}"
            elif b["type"] == "tool_use": d += f" tool_use:{b['name']} {json.dumps(b['input'], ensure_ascii=False)[:70]}"
            else: d += f" {b['type']}"
    elif t == "user":
        c = j["message"]["content"]
        if isinstance(c, str): d = f" text:{c[:100]!r}"
        else:
            for b in c:
                if b["type"] == "text": d += f" text:{b['text'][:100]!r}"
                elif b["type"] == "tool_result": d += f" tool_result:{str(b.get('content'))[:80]!r}"
        extra = {x: j[x] for x in ("isReplay", "uuid", "isSynthetic", "origin") if x in j}
        d += f" {extra}"
    elif t == "result":
        d = f" {st} turns={j.get('num_turns')} result={str(j.get('result'))[:70]!r} queued_turn_count={j.get('queued_turn_count')} sid={str(j.get('session_id'))[:8]}"
    elif t == "system":
        if st in ("hook_started", "hook_response", "thinking_tokens"): continue
        d = f" {st}" + (f" caps={j.get('capabilities')}" if st == "init" else "") if st in ("init",) else " " + json.dumps({x: v for x, v in j.items() if x not in ("type", "session_id", "uuid")}, ensure_ascii=False)[:200]
    elif t == "rate_limit_event": continue
    else: d = " " + json.dumps(j)[:200]
    print(f"{dt:6.2f} OUT    {t}/{st or ''}{d}")
