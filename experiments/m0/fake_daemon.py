#!/usr/bin/env python3
"""Fake agent-hub daemon for M0 experiments.

Listens on a TCP port and (optionally) a Unix socket, logs every request
(method, path, headers, body, arrival time) as one JSON line, and answers:

  POST /hooks/permission  -> PermissionRequest decision (allow / deny / hang)
  anything else           -> "ok <path>"

Usage:
  fake_daemon.py --log LOG --port PORT [--unix SOCK] [--decision allow|deny|hang]
                 [--hang-seconds N]
"""
import argparse, json, os, socketserver, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

args = None
lock = threading.Lock()


def log(entry):
    with lock, open(args.log, "a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


class Handler(BaseHTTPRequestHandler):
    def address_string(self):
        return "unix" if isinstance(self.client_address, (str, bytes)) else self.client_address[0]

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8", "replace") if n else ""
        t0 = time.time()
        entry = {"t": t0, "method": self.command, "path": self.path,
                 "via": self.server.via, "headers": dict(self.headers), "body": body}
        log(entry)
        if self.path.startswith("/hooks/permission"):
            if args.decision == "hang":
                time.sleep(args.hang_seconds)
                log({"t": time.time(), "event": "hang-finished", "slept": time.time() - t0})
                behavior = "allow"
            else:
                behavior = args.decision
            decision = {"behavior": behavior}
            if behavior == "deny":
                decision["message"] = "denied by fake daemon (M0 test)"
            out = json.dumps({"hookSpecificOutput": {
                "hookEventName": "PermissionRequest", "decision": decision}})
        else:
            out = "ok " + self.path + "\n"
        data = out.encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json" if out.startswith("{") else "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError) as e:
            log({"t": time.time(), "event": "client-gone", "error": repr(e)})

    do_GET = do_POST = _handle

    def log_message(self, *a):
        pass


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        req, _ = super().get_request()
        return req, "unix"


def main():
    global args
    p = argparse.ArgumentParser()
    p.add_argument("--log", required=True)
    p.add_argument("--port", type=int, required=True)
    p.add_argument("--unix")
    p.add_argument("--decision", default="allow", choices=["allow", "deny", "hang"])
    p.add_argument("--hang-seconds", type=float, default=300)
    args = p.parse_args()

    tcp = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    tcp.daemon_threads = True
    tcp.via = "tcp"
    threading.Thread(target=tcp.serve_forever, daemon=True).start()
    if args.unix:
        if os.path.exists(args.unix):
            os.unlink(args.unix)
        us = UnixHTTPServer(args.unix, Handler)
        us.via = "unix"
        threading.Thread(target=us.serve_forever, daemon=True).start()
    print(f"fake daemon up tcp=127.0.0.1:{args.port} unix={args.unix}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
