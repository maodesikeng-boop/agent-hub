import json,sys
for l in open(sys.argv[1]):
    try: o=json.loads(l)
    except: continue
    t=o.get('type')
    if t=='system' and o.get('subtype')=='init':
        print('init permissionMode=',o.get('permissionMode'),'tools=',len(o.get('tools',[])))
    if t=='result':
        print('RESULT:', o.get('result')); print('denials:', json.dumps([ (d.get('tool_name'), str(d.get('tool_input'))[:80]) for d in (o.get('permission_denials') or [])],ensure_ascii=False))
