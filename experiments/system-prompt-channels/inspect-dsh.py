# 用法: python3 -I ds-inspect.py <mock.log>：逐个请求看 system 里有没有探针、messages 里首条消息原文还在不在、有没有压缩摘要
import json, sys
for line in open(sys.argv[1]):
    r = json.loads(line); b = r["body"]
    if not isinstance(b, dict) or "messages" not in b: continue
    sysv = json.dumps(b.get("system"), ensure_ascii=False); msgs = json.dumps(b["messages"], ensure_ascii=False)
    print(f"request#{r['n']}: messages={len(b['messages'])} probe_in_system={'PROBE-FUSA-443' in sysv} "
          f"zwsp_escaped={'{\u200b{persona}}' in sysv} "
          f"control_first_message={'对照规则：对照短语是' in msgs} compacted_summary={'compacted-summary' in msgs}")
