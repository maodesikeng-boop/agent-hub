#!/usr/bin/env python3
"""Print a compact timeline of a codex steer run: summarize_codex.py out/NAME.jsonl"""
import json, sys

for line in open(sys.argv[1]):
    r = json.loads(line); dt, kind = r["dt"], r["kind"]
    if kind == "write":
        j = r["line"]
        if "method" in j and j["method"] in ("turn/start", "turn/steer", "thread/queue/add"):
            txt = " | ".join(b.get("text", "")[:80] for b in j["params"].get("input", []))
            print(f"{dt:7.2f} WRITE      {j['method']} id={j['id']} expectedTurnId={j['params'].get('expectedTurnId', '-')} {txt}")
        elif "method" in j and j["method"] != "initialize" and j["method"] != "initialized":
            print(f"{dt:7.2f} WRITE      {j['method']} id={j['id']}")
    elif kind == "approval":
        print(f"{dt:7.2f} approval   {r['method']}")
    elif kind == "stderr":
        pass
    elif kind == "driver":
        if "note" in r or "exit_code" in r:
            print(f"{dt:7.2f} driver     {r.get('note') or 'exit_code=' + str(r['exit_code'])}")
    elif kind == "stdout":
        j = r["json"]
        if "error" in j:
            print(f"{dt:7.2f} ERROR      id={j.get('id')} {json.dumps(j['error'], ensure_ascii=False)[:200]}")
        elif "method" in j and "id" not in j:
            m, pr = j["method"], j.get("params", {})
            if m in ("turn/started", "turn/completed"):
                t = pr["turn"]; print(f"{dt:7.2f} {m} turn={t['id'][-6:]} status={t.get('status')}")
            elif m in ("item/started", "item/completed"):
                it = pr["item"]; ty = it["type"]
                extra = ""
                if ty == "userMessage": extra = " " + json.dumps(it.get("content"), ensure_ascii=False)[:120]
                elif ty == "commandExecution": extra = f" {it.get('command', '')[:60]!r} status={it.get('status')}"
                elif ty == "agentMessage" and m == "item/completed": extra = f" {it.get('text', '')[:100]!r}"
                print(f"{dt:7.2f} {m} {ty}{extra} turn={pr.get('turnId', '')[-6:]}")
            elif m.startswith("mcpServer/") or m in ("warning", "thread/settings/updated", "account/updated", "remoteControl/status/changed", "thread/started"):
                pass
            elif m in ("item/agentMessage/delta", "item/commandExecution/outputDelta", "thread/tokenUsage/updated", "account/rateLimits/updated") or "reasoning" in m:
                pass
            else:
                print(f"{dt:7.2f} {m} {json.dumps(pr, ensure_ascii=False)[:120]}")
        elif "id" in j and "result" in j:
            res = j["result"]
            keys = list(res.keys())[:4]
            if keys and keys != ["thread"] and "userAgent" not in res:
                print(f"{dt:7.2f} response   id={j['id']} {json.dumps(res, ensure_ascii=False)[:160]}")
