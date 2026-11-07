import json,sys
for l in open(sys.argv[1]):
    try:o=json.loads(l)
    except: continue
    ev=o.get('event')
    if ev=='result':
        r=o['result']; print('RESULT status=',r.get('status'),'denied=',r.get('denied_actions')); print(r.get('response','')[:2500])
    elif ev=='step_update':
        su=o['step_update']
        if su.get('step_type')=='tool' and su.get('state') in ('DONE','ERROR','CANCELED','CANCELLED'):
            print(' tool',su.get('tool_name'),su.get('state'),json.dumps(su.get('tool_info',{}).get('parameters'),ensure_ascii=False)[:140])
