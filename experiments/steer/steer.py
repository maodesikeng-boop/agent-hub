#!/usr/bin/env python3
"""Mid-turn message experiment driver (stream-json input, real claude, tools ON).

Usage: steer.py SCENARIO.json OUT.jsonl -- <claude args...>

Steps (list in SCENARIO):
  {"send": "text" | "blocks": [..], "extra": {"priority": "now", "origin": {"kind": "human"}}, "uuid": "u1"}
  {"wait_tool": "Bash", "nth": 1}      wait until the nth assistant tool_use of that name
  {"wait_text": "substr"}              wait until an assistant text block contains substr
  {"wait_stream_text": 3}              wait for N text_delta stream events (needs --include-partial-messages)
  {"wait_user_result": 1}              wait for nth tool_result user event
  {"wait": "result", "nth": 1}         wait until nth result event (timeout 180s)
  {"sleep": s}
  {"control": {...}}                   write a raw control_request line
  {"close": true}, {"exit": s}
Each stdout/stderr line is recorded with dt (sec since spawn) and, for writes, kind=write.
"""
import json, os, subprocess, sys, threading, time, queue

scenario = json.load(open(sys.argv[1]))
out_path = sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
here = os.path.dirname(os.path.abspath(__file__))
cmd = [os.path.join(here, "..", "m0", "claude_clean.sh")] + cmd
t0 = time.time()
out = open(out_path, "w")
events = queue.Queue()
lock = threading.Lock()
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)


def rec(kind, payload):
    with lock:
        out.write(json.dumps({"dt": round(time.time() - t0, 2), "kind": kind, **payload}, ensure_ascii=False) + "\n")
        out.flush()


def reader(stream, kind):
    for line in stream:
        line = line.rstrip("\n")
        try:
            obj = json.loads(line)
        except Exception:
            obj = None
        rec(kind, {"json": obj} if obj is not None else {"text": line})
        if obj is not None and kind == "stdout":
            events.put(obj)
    events.put({"type": "__eof__"})


threading.Thread(target=reader, args=(p.stdout, "stdout"), daemon=True).start()
threading.Thread(target=reader, args=(p.stderr, "stderr"), daemon=True).start()

seen = {"tool": {}, "result": 0, "stream_text": 0, "tool_result": 0, "texts": []}


def update(ev):
    t = ev.get("type")
    if t == "result":
        seen["result"] += 1
    elif t == "assistant":
        for b in ev.get("message", {}).get("content", []):
            if b.get("type") == "tool_use":
                seen["tool"][b["name"]] = seen["tool"].get(b["name"], 0) + 1
            if b.get("type") == "text":
                seen["texts"].append(b["text"])
    elif t == "user":
        c = ev.get("message", {}).get("content")
        if isinstance(c, list) and any(b.get("type") == "tool_result" for b in c):
            seen["tool_result"] += 1
    elif t == "stream_event":
        d = ev.get("event", {}).get("delta", {})
        if d.get("type") == "text_delta":
            seen["stream_text"] += 1


def wait_until(pred, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        try:
            ev = events.get(timeout=0.2)
        except queue.Empty:
            continue
        if ev.get("type") == "__eof__":
            return pred()
        update(ev)
    rec("driver", {"note": "timeout"})
    return False


def write(line):
    rec("write", {"line": json.loads(line)})
    try:
        p.stdin.write(line + "\n"); p.stdin.flush()
    except BrokenPipeError:
        rec("driver", {"note": "stdin broken"})


for step in scenario:
    rec("driver", {"step": step})
    if "send" in step or "blocks" in step:
        blocks = step.get("blocks") or [step["send"]]
        msg = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": b} for b in blocks]}}
        if "uuid" in step:
            msg["uuid"] = step["uuid"]
        msg.update(step.get("extra", {}))
        write(json.dumps(msg, ensure_ascii=False))
    elif "control" in step:
        write(json.dumps(step["control"]))
    elif "wait_tool" in step:
        n = step.get("nth", 1)
        wait_until(lambda: seen["tool"].get(step["wait_tool"], 0) >= n)
    elif "wait_text" in step:
        wait_until(lambda: any(step["wait_text"] in t for t in seen["texts"]))
    elif "wait_stream_text" in step:
        wait_until(lambda: seen["stream_text"] >= step["wait_stream_text"])
    elif "wait_user_result" in step:
        wait_until(lambda: seen["tool_result"] >= step["wait_user_result"])
    elif step.get("wait") == "result":
        n = step.get("nth", 1)
        wait_until(lambda: seen["result"] >= n, step.get("timeout", 180))
    elif "sleep" in step:
        # keep draining while sleeping
        end = time.time() + step["sleep"]
        while time.time() < end:
            try:
                ev = events.get(timeout=0.1); update(ev)
            except queue.Empty:
                pass
    elif step.get("close"):
        p.stdin.close()
    elif "exit" in step:
        try:
            p.wait(timeout=step["exit"])
        except subprocess.TimeoutExpired:
            rec("driver", {"note": "still running, killing"}); p.kill(); p.wait()

if p.poll() is None:
    try: p.stdin.close()
    except Exception: pass
    try: p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        rec("driver", {"note": "killing"}); p.kill(); p.wait()
time.sleep(0.5)
rec("driver", {"exit_code": p.returncode})
print("exit", p.returncode)
