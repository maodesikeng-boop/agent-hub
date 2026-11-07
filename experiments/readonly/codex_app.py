# 最小 codex app-server 驱动：read-only + on-request，记录所有 server request，一律拒；顺便测 mcpServerStatus/list 耗时和 annotations
import json,subprocess,sys,time,os
C="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
env={k:v for k,v in os.environ.items() if not k.startswith("HUB_")}
p=subprocess.Popen([C,"app-server","-c",'mcp_servers.rotest.command="node"',"-c",'mcp_servers.rotest.args=["/tmp/ro110/mcp/server.mjs"]',"-c",'service_tier="default"'],
    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open("/tmp/ro110/err-codex-app.txt","w"),text=True,cwd="/tmp/ro110/ws",env=env)
t0=time.time()
def send(o): p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
def ms(): return int((time.time()-t0)*1000)
send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"ro110","version":"0"}}})
send({"jsonrpc":"2.0","method":"initialized"})
send({"jsonrpc":"2.0","id":2,"method":"mcpServerStatus/list","params":{"detail":"toolsAndAuthOnly"}})
prompt=open("/tmp/ro110/prompt-codex-mcp.txt").read()
for line in p.stdout:
    try:o=json.loads(line)
    except: continue
    if o.get("id")==1 and "result" in o: print("initialize ms",ms())
    if o.get("id")==2:
        print("mcpServerStatus/list ms",ms())
        for s in (o.get("result") or {}).get("data",[]):
            tools=s.get("tools") or {}
            ro=sum(1 for t in tools.values() if ((t or {}).get("annotations") or {}).get("readOnlyHint"))
            print("  ",s["name"],"tools",len(tools),"readOnlyHint",ro, s.get("toolsError") or "")
            if s["name"]=="rotest": print("    ",{k:(v or {}).get("annotations") for k,v in tools.items()})
        send({"jsonrpc":"2.0","id":3,"method":"thread/start","params":{"cwd":"/tmp/ro110/ws","model":"gpt-5.6-luna","sandbox":"read-only","approvalPolicy":"on-request","ephemeral":True}})
    if o.get("id")==3:
        tid=o["result"]["thread"]["id"]
        send({"jsonrpc":"2.0","id":4,"method":"turn/start","params":{"threadId":tid,"input":[{"type":"text","text":prompt}],"effort":"low","sandboxPolicy":{"type":"readOnly","networkAccess":True}}})
    if "method" in o and "id" in o:
        print("SERVER REQUEST",o["method"],json.dumps(o.get("params"),ensure_ascii=False)[:400])
        m=o["method"]
        if m=="mcpServer/elicitation/request": send({"jsonrpc":"2.0","id":o["id"],"result":{"action":"decline","content":None,"_meta":None}})
        else: send({"jsonrpc":"2.0","id":o["id"],"result":{"decision":"decline"}})
    if o.get("method")=="item/completed":
        it=o["params"]["item"]
        if it.get("type") in ("mcpToolCall",): print(" item",it.get("tool"),it.get("status"),json.dumps(it.get("error"),ensure_ascii=False)[:150])
        if it.get("type")=="agentMessage": print(" MSG",it.get("text","")[:400])
    if o.get("method")=="turn/completed": print("turn completed ms",ms()); break
p.kill()
