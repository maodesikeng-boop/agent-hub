import json,subprocess,time,os
env={k:v for k,v in os.environ.items() if not (k.startswith("CLAUDE") or k.startswith("HUB_") or k=="ENABLE_TOOL_SEARCH")}
args=["claude","-p","--input-format","stream-json","--output-format","stream-json","--verbose","--no-session-persistence","--model","haiku","--settings","/tmp/ro110/s-nohooks.json","--mcp-config","/tmp/ro110/mcp/claude-mcp.json","--strict-mcp-config"]
p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,cwd="/tmp/ro110/ws",env=env)
t0=time.time(); n=0; times=[]
def ask():
    global ts; ts=time.time(); p.stdin.write(json.dumps({"type":"control_request","request_id":"s","request":{"subtype":"mcp_status"}})+"\n"); p.stdin.flush()
p.stdin.write(json.dumps({"type":"control_request","request_id":"i","request":{"subtype":"initialize"}})+"\n"); p.stdin.flush()
for line in p.stdout:
    o=json.loads(line) if line.startswith("{") else {}
    if o.get("type")!="control_response": continue
    r=o["response"]
    if r["request_id"]=="i": print("initialize ms",int((time.time()-t0)*1000)); ask(); continue
    st=r["response"]["mcpServers"][0]["status"]
    if st=="pending": time.sleep(0.05); ask(); continue
    times.append(round((time.time()-ts)*1000,1))
    if len(times)==1: print("connected at ms",int((time.time()-t0)*1000))
    if len(times)>=5: break
    ask()
print("mcp_status latency after connect (ms):",times); p.kill()
