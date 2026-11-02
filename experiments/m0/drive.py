#!/usr/bin/env python3
"""Drive one `claude -p --input-format stream-json` process through a scenario.

Usage: drive.py SCENARIO.json OUT.jsonl -- <claude args...>

SCENARIO is a list of steps:
  {"send": "text"}             write one user message line to stdin
  {"raw": "<line>"}            write a raw line to stdin
  {"wait": "result"}           wait until the next `result` event (timeout 300s)
  {"wait": "init"}             wait until a system/init event
  {"wait_type": "assistant"}   wait until an event of that type
  {"sleep": seconds}
  {"signal": "INT"|"TERM"}     signal the claude process
  {"close": true}              close stdin
  {"exit": seconds}            wait up to N s for the process to exit
Every stdout line is written to OUT with an arrival timestamp; stderr too.
"""
import json, os, signal, subprocess, sys, threading, time, queue

scenario = json.load(open(sys.argv[1]))
out_path = sys.argv[2]
cmd = sys.argv[sys.argv.index("--") + 1:]
here = os.path.dirname(os.path.abspath(__file__))
cmd = [os.path.join(here, "claude_clean.sh")] + cmd

t0 = time.time()
out = open(out_path, "w")
events = queue.Queue()
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True, bufsize=1)


def rec(kind, payload):
    out.write(json.dumps({"dt": round(time.time() - t0, 2), "kind": kind, **payload}) + "\n")
    out.flush()


def reader(stream, kind):
    for line in stream:
        line = line.rstrip("\n")
        try:
            obj = json.loads(line)
        except Exception:
            obj = None
        rec(kind, {"json": obj} if obj is not None else {"text": line})
        if obj is not None:
            events.put(obj)
    events.put({"type": "__eof__", "stream": kind})


threading.Thread(target=reader, args=(p.stdout, "stdout"), daemon=True).start()
threading.Thread(target=reader, args=(p.stderr, "stderr"), daemon=True).start()


def wait_for(pred, timeout=300):
    end = time.time() + timeout
    while time.time() < end:
        try:
            ev = events.get(timeout=1)
        except queue.Empty:
            continue
        if ev.get("type") == "__eof__" and ev.get("stream") == "stdout":
            return None
        if pred(ev):
            return ev
    rec("driver", {"note": "timeout"})
    return None


def user_line(text):
    return json.dumps({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}})


for step in scenario:
    rec("driver", {"step": step})
    if "send" in step or "raw" in step:
        line = user_line(step["send"]) if "send" in step else step["raw"]
        try:
            p.stdin.write(line + "\n"); p.stdin.flush()
        except BrokenPipeError:
            rec("driver", {"note": "stdin broken"})
    elif step.get("wait") == "result":
        wait_for(lambda e: e.get("type") == "result", step.get("timeout", 300))
    elif step.get("wait") == "init":
        wait_for(lambda e: e.get("type") == "system" and e.get("subtype") == "init", 120)
    elif "wait_type" in step:
        wait_for(lambda e: e.get("type") == step["wait_type"], step.get("timeout", 300))
    elif "sleep" in step:
        time.sleep(step["sleep"])
    elif "signal" in step:
        p.send_signal(getattr(signal, "SIG" + step["signal"]))
    elif step.get("close"):
        try:
            p.stdin.close()
        except BrokenPipeError:
            pass
    elif "exit" in step:
        try:
            p.wait(timeout=step["exit"])
        except subprocess.TimeoutExpired:
            rec("driver", {"note": "still running, killing"})
            p.kill(); p.wait()

if p.poll() is None:
    try:
        p.stdin.close()
    except Exception:
        pass
    try:
        p.wait(timeout=60)
    except subprocess.TimeoutExpired:
        p.kill(); p.wait()
time.sleep(0.5)
rec("driver", {"exit_code": p.returncode})
print("exit", p.returncode)
