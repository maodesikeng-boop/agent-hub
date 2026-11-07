import json,subprocess,sys,time,os
env={k:v for k,v in os.environ.items() if not (k.startswith("CLAUDE") or k.startswith("HUB_") or k=="ENABLE_TOOL_SEARCH")}
args=["claude","-p","--input-format","stream-json","--output-format","stream-json","--verbose","--no-session-persistence","--model","haiku",
      "--settings","/tmp/ro110/s-nohooks.json","--permission-mode","plan"]+sys.argv[1:]
t0=time.time()
p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,cwd="/tmp/ro110/ws",env=env)
p.stdin.write(json.dumps({"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}})+"\n")
p.stdin.write(json.dumps({"type":"control_request","request_id":"r2","request":{"subtype":"mcp_status"}})+"\n"); p.stdin.flush()
for line in p.stdout:
    try: o=json.loads(line)
    except: continue
    if o.get("type")=="control_response":
        r=o["response"]
        if r.get("request_id")=="r2":
            if any(x.get("status")=="pending" for x in r.get("response",{}).get("mcpServers",[])) and time.time()-t0<60:
                time.sleep(0.2); p.stdin.write(json.dumps({"type":"control_request","request_id":"r2","request":{"subtype":"mcp_status"}})+"\n"); p.stdin.flush(); continue
            print("ms_to_mcp_status=%d"%((time.time()-t0)*1000))
            for s in r.get("response",{}).get("mcpServers",[]):
                print(s.get("name"),s.get("status"),s.get("scope"),"tools:",len(s.get("tools") or []))
                for t in (s.get("tools") or [])[:int(os.environ.get("N","50"))]: print("   ",t.get("name"),json.dumps(t.get("annotations")))
            if any(x.get("status")=="pending" for x in r.get("response",{}).get("mcpServers",[])):
                time.sleep(0.2); p.stdin.write(json.dumps({"type":"control_request","request_id":"r2","request":{"subtype":"mcp_status"}})+"\n"); p.stdin.flush(); continue
            break
        else: print("init ms=%d"%((time.time()-t0)*1000), "keys", list(r.get("response",{}).keys())[:12])
p.kill()
