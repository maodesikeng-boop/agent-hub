#!/usr/bin/env python3
"""codex app-server mid-turn message experiment driver (JSON-RPC over stdio, real codex, command execution ON).

Usage: steer_codex.py SCENARIO.json OUT.jsonl
Launch/handshake = codex-driver: `codex app-server --listen stdio://`, initialize(experimentalApi) -> initialized
  -> thread/start {cwd, model, sandbox workspace-write, approvalPolicy on-request}; turn/start with sandboxPolicy workspaceWrite.
Server approval requests are auto-accepted (recorded as kind=approval).

Steps (list in SCENARIO):
  {"turn_start": "text"}                   turn/start (new turn; if a turn is active this tests the busy case)
  {"steer": "text"}                        turn/steer with expectedTurnId = current active turn
  {"steer": "text", "expected": "bogus"}   turn/steer with a wrong expectedTurnId
  {"queue_add": "text"} {"queue_start": true} {"queue_list": true}    thread/queue/*
  {"interrupt": true}                      turn/interrupt for the active turn
  {"wait_cmd": 1}                          nth commandExecution item/started
  {"wait_cmd_done": 1}                     nth commandExecution item/completed
  {"wait_delta": 3}                        N item/agentMessage/delta notifications
  {"wait_user_item": 2}                    nth userMessage item/started
  {"wait_turn_done": 1, "timeout": 180}    nth turn/completed
  {"sleep": s} {"close": true} {"exit": s}
Every stdout/stderr line recorded with dt (sec since spawn); our writes get kind=write.
"""
import json, os, queue, signal, subprocess, sys, threading, time

scenario = json.load(open(sys.argv[1]))
out_path = sys.argv[2]
CODEX = os.environ.get("CODEX", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")
MODEL = os.environ.get("CODEX_MODEL", "gpt-5.6-luna")
CWD = os.getcwd()
t0 = time.time()
out = open(out_path, "w")
events = queue.Queue()
lock = threading.Lock()
p = subprocess.Popen([CODEX, "app-server", "--listen", "stdio://"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True, bufsize=1, start_new_session=True)
pending = {}  # id -> method
state = {"thread": None, "turn": None, "next_id": 1}
seen = {"cmd": 0, "cmd_done": 0, "delta": 0, "user_item": 0, "turn_done": 0}


def rec(kind, payload):
    with lock:
        out.write(json.dumps({"dt": round(time.time() - t0, 2), "kind": kind, **payload}, ensure_ascii=False) + "\n")
        out.flush()


def send(obj, label=None):
    rec("write", {"line": obj})
    try:
        p.stdin.write(json.dumps(obj, ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + "\n")
        p.stdin.flush()
    except BrokenPipeError:
        rec("driver", {"note": "stdin broken"})


def request(method, params):
    i = state["next_id"]; state["next_id"] += 1
    pending[i] = method
    send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
    return i


def on_msg(m):
    if "method" in m and "id" in m:  # server request
        meth = m["method"]
        rec("approval", {"method": meth})
        if "requestApproval" in meth:
            send({"jsonrpc": "2.0", "id": m["id"], "result": {"decision": "accept"}})
        else:
            send({"jsonrpc": "2.0", "id": m["id"], "result": {}})
        return
    if "method" in m:
        meth, pr = m["method"], m.get("params", {})
        if meth == "turn/started":
            state["turn"] = pr["turn"]["id"]
        elif meth == "turn/completed":
            seen["turn_done"] += 1
            state["turn"] = None
        elif meth == "item/started":
            t = pr["item"]["type"]
            if t == "commandExecution": seen["cmd"] += 1
            if t == "userMessage": seen["user_item"] += 1
        elif meth == "item/completed" and pr["item"]["type"] == "commandExecution":
            seen["cmd_done"] += 1
        elif meth == "item/agentMessage/delta":
            seen["delta"] += 1
    elif "id" in m:
        meth = pending.pop(m["id"], None)
        r = m.get("result") or {}
        if meth == "thread/start" and "thread" in r:
            state["thread"] = r["thread"]["id"]
        if meth in ("turn/start", "turn/steer") and "error" not in m:
            tid = (r.get("turn") or {}).get("id") or r.get("turnId")
            if meth == "turn/start" and tid: state["turn"] = tid


def reader(stream, kind):
    for line in stream:
        line = line.rstrip("\n")
        try: obj = json.loads(line)
        except Exception: obj = None
        rec(kind, {"json": obj} if obj is not None else {"text": line})
        if obj is not None and kind == "stdout":
            events.put(obj)
    events.put({"__eof__": True})


threading.Thread(target=reader, args=(p.stdout, "stdout"), daemon=True).start()
threading.Thread(target=reader, args=(p.stderr, "stderr"), daemon=True).start()


def pump(timeout=0.2):
    try:
        ev = events.get(timeout=timeout)
    except queue.Empty:
        return None
    if ev.get("__eof__"):
        return "eof"
    on_msg(ev)
    return ev


def wait_until(pred, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        if pred(): return True
        if pump() == "eof": return pred()
    rec("driver", {"note": "timeout"})
    return False


def turn_params(text):
    return {"threadId": state["thread"], "input": [{"type": "text", "text": text}], "cwd": CWD, "model": MODEL, "summary": "detailed",
            "sandboxPolicy": {"type": "workspaceWrite", "networkAccess": True, "writableRoots": [CWD]}}


# handshake
request("initialize", {"clientInfo": {"name": "agent-hub", "title": "Agent Hub", "version": "0.1.0"}, "capabilities": {"experimentalApi": True}})
wait_until(lambda: 1 not in pending, 30)
send({"jsonrpc": "2.0", "method": "initialized"})
request("thread/start", {"cwd": CWD, "model": MODEL, "developerInstructions": "You are a test agent. Follow the user's instructions exactly and concisely.",
                         "sandbox": "workspace-write", "approvalPolicy": "on-request"})
wait_until(lambda: state["thread"] is not None, 30)

for step in scenario:
    rec("driver", {"step": step})
    if "turn_start" in step:
        request("turn/start", turn_params(step["turn_start"]))
    elif "steer" in step:
        wait_until(lambda: state["turn"] is not None, 5)
        request("turn/steer", {"threadId": state["thread"], "expectedTurnId": step.get("expected") or state["turn"],
                               "input": [{"type": "text", "text": step["steer"]}]})
    elif "steer_blocks" in step:
        request("turn/steer", {"threadId": state["thread"], "expectedTurnId": state["turn"],
                               "input": [{"type": "text", "text": b} for b in step["steer_blocks"]]})
    elif "queue_add" in step:
        request("thread/queue/add", {"threadId": state["thread"], "clientUserMessageId": "q%d" % state["next_id"],
                                     "input": [{"type": "text", "text": step["queue_add"]}]})
    elif "queue_start" in step:
        request("thread/queue/start", {"threadId": state["thread"]})
    elif "queue_list" in step:
        request("thread/queue/list", {"threadId": state["thread"]})
    elif "interrupt" in step:
        request("turn/interrupt", {"threadId": state["thread"], "turnId": state["turn"]})
    elif "wait_cmd" in step:
        wait_until(lambda: seen["cmd"] >= step["wait_cmd"], step.get("timeout", 180))
    elif "wait_cmd_done" in step:
        wait_until(lambda: seen["cmd_done"] >= step["wait_cmd_done"], step.get("timeout", 180))
    elif "wait_delta" in step:
        wait_until(lambda: seen["delta"] >= step["wait_delta"], step.get("timeout", 180))
    elif "wait_user_item" in step:
        wait_until(lambda: seen["user_item"] >= step["wait_user_item"], step.get("timeout", 180))
    elif "wait_turn_done" in step:
        wait_until(lambda: seen["turn_done"] >= step["wait_turn_done"], step.get("timeout", 180))
    elif "sleep" in step:
        end = time.time() + step["sleep"]
        while time.time() < end: pump(0.1)
    elif step.get("close"):
        p.stdin.close()
    elif "exit" in step:
        try: p.wait(timeout=step["exit"])
        except subprocess.TimeoutExpired:
            rec("driver", {"note": "still running, killing"}); os.killpg(p.pid, signal.SIGKILL); p.wait()

if p.poll() is None:
    try: p.stdin.close()
    except Exception: pass
    try: p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        rec("driver", {"note": "killing"}); os.killpg(p.pid, signal.SIGKILL); p.wait()
time.sleep(0.3)
rec("driver", {"exit_code": p.returncode})
print("exit", p.returncode)
