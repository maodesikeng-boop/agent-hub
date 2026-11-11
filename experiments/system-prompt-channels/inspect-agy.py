# 用法: python3 -I agy-inspect.py <conversation.db>：逐个请求看系统提示词 <user_rules> 里有没有探针、首条消息原文还在不在、有没有压缩摘要
import sqlite3, sys
db = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
for idx, data in db.execute("select idx, data from gen_metadata order by idx"):
    s = data.decode("utf8", "replace")
    ur = s.find("<user_rules>"); ue = s.find("</user_rules>")
    rules = s[ur:ue] if ur >= 0 else ""
    after = s[ue:] if ue >= 0 else s
    summary = after.find("<CONTEXT_SUMMARY>")
    head = after[:summary] if summary >= 0 else after
    print(f"request#{idx}: bytes={len(data)} rule_files={rules.count('<RULE[')} probe_in_user_rules={'PROBE-FUSA-443' in rules} "
          f"context_summary={summary >= 0} control_first_message_verbatim={'对照规则：对照短语是 CONTROL-RED-OTTER-4410' in head}")
