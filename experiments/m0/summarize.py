#!/usr/bin/env python3
"""Print a compact timeline of a drive.py output file."""
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line)
    dt = r["dt"]
    if r["kind"] == "driver":
        print(f"{dt:7.2f} DRIVER {json.dumps({k: v for k, v in r.items() if k not in ('dt', 'kind')}, ensure_ascii=False)}")
        continue
    if "text" in r:
        print(f"{dt:7.2f} {r['kind']} TEXT {r['text'][:300]}")
        continue
    e = r["json"]; t = e.get("type"); st = e.get("subtype", "")
    extra = ""
    if t == "system" and st == "init":
        extra = f"session={e.get('session_id')} model={e.get('model')} cwd={e.get('cwd')}"
    elif t in ("assistant", "user"):
        parts = []
        for c in (e.get("message", {}).get("content") or []):
            if isinstance(c, str):
                parts.append(c[:120])
            elif c.get("type") == "text":
                parts.append("text:" + c["text"][:160].replace("\n", " "))
            elif c.get("type") == "tool_use":
                parts.append("tool_use:" + json.dumps(c.get("input"))[:160])
            elif c.get("type") == "tool_result":
                cc = c.get("content")
                parts.append("tool_result:" + (json.dumps(cc) if not isinstance(cc, str) else cc)[:200].replace("\n", " "))
            else:
                parts.append(c.get("type"))
        extra = " | ".join(parts)
        if e.get("isReplay"): extra = "[replay] " + extra
    elif t == "result":
        extra = f"is_error={e.get('is_error')} result={str(e.get('result'))[:200]!r} turns={e.get('num_turns')} session={e.get('session_id')} denials={e.get('permission_denials')}"
        if e.get("structured_output") is not None:
            extra += " structured=" + json.dumps(e["structured_output"], ensure_ascii=False)
    else:
        extra = json.dumps(e, ensure_ascii=False)[:300]
    print(f"{dt:7.2f} {t}/{st} {extra}")
