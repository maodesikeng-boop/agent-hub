#!/usr/bin/env python3
"""agy mid-turn message experiment driver (stream-json input, real agy, tools ON).

Usage: steer_agy.py SCENARIO.json OUT.jsonl [-- extra agy args]
Launch args = agy driver's buildAgyArgs: --input-format stream-json --output-format stream-json
  --mode auto --dangerously-skip-permissions --model gemini-3.8-flash-low --print ""

Steps (list in SCENARIO):
  {"send": "text"} | {"blocks": [..]}      write one {"event":"user",...} line
  {"wait_tool": 1}                          nth step_update tool ACTIVE (a tool call started)
  {"wait_tool_done": 1}                     nth tool step DONE
  {"wait_delta": 3}                         N agent_response text_delta events
  {"wait_user_step": 2}                     nth user_input step_update DONE
  {"wait": "result", "nth": 1, "timeout": 180}
  {"sleep": s} {"signal": "SIGINT"} {"close": true} {"exit": s}
Every stdout/stderr line is recorded with dt (sec since spawn); writes get kind=write.
"""
import json, os, queue, signal, subprocess, sys, threading, time

scenario = json.load(open(sys.argv[1]))
out_path = sys.argv[2]
extra = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
AGY = os.environ.get("AGY", os.path.expanduser("~/.local/bin/agy"))
MODEL = os.environ.get("AGY_MODEL", "gemini-3.8-flash-low")
cmd = [AGY, "--input-format", "stream-json", "--output-format", "stream-json", "--mode", "auto",
       "--dangerously-skip-permissions", "--model", MODEL, *extra, "--print", ""]
t0 = time.time()
out = open(out_path, "w")
events = queue.Queue()
lock = threading.Lock()
p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
                     start_new_session=True)


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
    events.put({"event": "__eof__"})


threading.Thread(target=reader, args=(p.stdout, "stdout"), daemon=True).start()
threading.Thread(target=reader, args=(p.stderr, "stderr"), daemon=True).start()

seen = {"tool": 0, "tool_done": 0, "result": 0, "delta": 0, "user_step": 0}


def update(ev):
    t = ev.get("event")
    if t == "result":
        seen["result"] += 1
    elif t == "step_update":
        su = ev.get("step_update", {})
        st, state = su.get("step_type"), su.get("state")
        if st == "tool" and state == "ACTIVE":
            seen["tool"] += 1
        elif st == "tool" and state == "DONE":
            seen["tool_done"] += 1
        elif st == "user_input" and state == "DONE":
            seen["user_step"] += 1
        elif st == "agent_response" and su.get("text_delta"):
            seen["delta"] += 1


def wait_until(pred, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        try:
            ev = events.get(timeout=0.2)
        except queue.Empty:
            continue
        if ev.get("event") == "__eof__":
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
        write(json.dumps({"event": "user", "message": {"content": [{"type": "text", "text": b} for b in blocks]}}, ensure_ascii=False))
    elif "wait_tool" in step:
        wait_until(lambda: seen["tool"] >= step["wait_tool"], step.get("timeout", 180))
    elif "wait_tool_done" in step:
        wait_until(lambda: seen["tool_done"] >= step["wait_tool_done"], step.get("timeout", 180))
    elif "wait_delta" in step:
        wait_until(lambda: seen["delta"] >= step["wait_delta"], step.get("timeout", 180))
    elif "wait_user_step" in step:
        wait_until(lambda: seen["user_step"] >= step["wait_user_step"], step.get("timeout", 180))
    elif step.get("wait") == "result":
        wait_until(lambda: seen["result"] >= step.get("nth", 1), step.get("timeout", 180))
    elif "sleep" in step:
        end = time.time() + step["sleep"]
        while time.time() < end:
            try:
                update(events.get(timeout=0.1))
            except queue.Empty:
                pass
    elif "signal" in step:
        os.kill(p.pid, getattr(signal, step["signal"]))
    elif step.get("close"):
        p.stdin.close()
    elif "exit" in step:
        try:
            p.wait(timeout=step["exit"])
        except subprocess.TimeoutExpired:
            rec("driver", {"note": "still running, killing"}); os.killpg(p.pid, signal.SIGKILL); p.wait()

if p.poll() is None:
    try: p.stdin.close()
    except Exception: pass
    try: p.wait(timeout=30)
    except subprocess.TimeoutExpired:
        rec("driver", {"note": "killing"}); os.killpg(p.pid, signal.SIGKILL); p.wait()
time.sleep(0.5)
rec("driver", {"exit_code": p.returncode})
print("exit", p.returncode)
