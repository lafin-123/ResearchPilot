import csv,json,math,sys,os
from pathlib import Path
root=Path(sys.argv[1]).resolve()
if os.name=='nt' and not str(root).startswith('\\\\?\\'): root=Path('\\\\?\\'+str(root))
reports=[]
for path in root.glob('experiments/*/runs/*/observations.csv'):
    with path.open(encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
    if not rows: continue
    checked=0;problems=[];groups={}
    for row in rows:
        try:
            estimate=float(row.get('estimate',row.get('estimate_value','nan')))
            truth=float(row.get('true_integral',row.get('truth',row.get('true_value','nan'))))
            error=float(row.get('error','nan'))
            if not all(map(math.isfinite,[estimate,truth,error])): continue
            checked+=1
            if not math.isclose(estimate-truth,error,rel_tol=1e-9,abs_tol=1e-12):problems.append('estimate/truth/error mismatch')
            group=(row.get('scenario'),row.get('method'),row.get('budget'))
            groups.setdefault(group,[]).append(error)
        except (ValueError,TypeError):problems.append('invalid numeric observation')
    summary=[{'scenario':k[0],'method':k[1],'budget':k[2],'n':len(v),'mae':sum(abs(x) for x in v)/len(v),'rmse':math.sqrt(sum(x*x for x in v)/len(v))} for k,v in groups.items()]
    reports.append({'file':str(path.relative_to(root)),'rows':len(rows),'independentlyChecked':checked,'problems':sorted(set(problems)),'summary':summary})
print(json.dumps({'scope':'independent recomputation from actual CSV; not model-produced manuscript values','runs':reports},ensure_ascii=False,indent=2))
