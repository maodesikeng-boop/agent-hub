# default 模式 + --permission-prompt-tool stdio：要批准的发 can_use_tool 给我们，按 mcp_status 的 annotations 决定
import json,subprocess,sys,time,os
env={k:v for k,v in os.environ.items() if not (k.startswith("CLAUDE") or k.startswith("HUB_") or k=="ENABLE_TOOL_SEARCH")}
EXTRA_ALLOW={"mcp__rotest__plain_tool"}
args=["claude","-p","--input-format","stream-json","--output-format","stream-json","--verbose","--no-session-persistence","--model","sonnet","--effort","low",
      "--settings","/tmp/ro110/s-dyn.json","--permission-prompt-tool","stdio","--mcp-config","/tmp/ro110/mcp/claude-mcp.json","--strict-mcp-config"]
p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open("/tmp/ro110/err-dyn.txt","w"),text=True,cwd="/tmp/ro110/ws",env=env)
def send(o): p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
send({"type":"control_request","request_id":"init","request":{"subtype":"initialize"}})
prompt=open("/tmp/ro110/prompt.txt").read()+"\n"+"\n".join(open("/tmp/ro110/prompt-mcp.txt").read().splitlines()[1:]).replace("1. mcp","11. mcp").replace("2. mcp","12. mcp").replace("3. mcp","13. mcp")
send({"type":"user","message":{"role":"user","content":prompt}})
ann={}
for line in p.stdout:
    try: o=json.loads(line)
    except: continue
    t=o.get("type")
    if t=="control_request" and o["request"].get("subtype")=="can_use_tool":
        r=o["request"]; name=r["tool_name"]
        if name.startswith("mcp__") and not ann:
            send({"type":"control_request","request_id":"st","request":{"subtype":"mcp_status"}})
            pending=o; continue
        print("can_use_tool:",name,json.dumps(r.get("input"))[:80],"keys=",sorted(r.keys()))
        ok = name in EXTRA_ALLOW
        send({"type":"control_response","response":{"subtype":"success","request_id":o["request_id"],"response":{"behavior":"allow","updatedInput":r["input"]} if ok else {"behavior":"deny","message":"只读 Worker 不能用这个工具"}}})
    elif t=="control_response" and o["response"].get("request_id")=="st":
        for s in o["response"]["response"]["mcpServers"]:
            for tl in s.get("tools") or []: ann[f"mcp__{s['name']}__{tl['name']}"]=tl.get("annotations") or {}
        r=pending["request"]; name=r["tool_name"]
        ok = (ann.get(name) or {}).get("readOnly") is True or name in EXTRA_ALLOW
        print("can_use_tool:",name,"ann=",ann.get(name),"->",ok,"keys=",sorted(r.keys()))
        send({"type":"control_response","response":{"subtype":"success","request_id":pending["request_id"],"response":{"behavior":"allow","updatedInput":r["input"]} if ok else {"behavior":"deny","message":"只读 Worker 不能用这个工具"}}})
    elif t=="result":
        print("RESULT:",o.get("result")); break
p.kill()
