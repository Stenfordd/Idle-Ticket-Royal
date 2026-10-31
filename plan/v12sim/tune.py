import json,random,sim
CL=['bers','burn','excel','monk','hunt']
def run(N,s):
    tot={c:0 for c in CL}; T=0;n=0
    for a in CL:
        for b in CL:
            if a>=b: continue
            for i in range(N):
                r,t=sim.fight(a,b,s,s); tot[a]+=r; tot[b]+=1-r; T+=t; n+=1
    return {c:tot[c]/(N*4) for c in CL}, T/n
P=sim.P
for it in range(12):
    w,t=run(500,0.5)
    print(it,{c:round(v,2) for c,v in w.items()},round(t,1))
    for c in CL: P['dm'][c]*=(0.5/max(w[c],0.03))**0.1
    g=(t/11)**0.3
    for c in CL: P['dm'][c]*=g
json.dump(P,open('p_tuned.json','w'),indent=0)
print({c:round(v,2) for c,v in P['dm'].items()})
