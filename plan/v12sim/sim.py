import random, sys, json
U=120; BASEHP=3000; HEAL=0.65; CAP=0.35
P=json.load(open(__import__('os').environ.get('PF','p.json')))
HPM=P['hpm']; DM=P['dm']
class F:
    def __init__(s,cls,sk):
        s.c=cls; s.sk=sk; s.mx=BASEHP*HPM[cls]; s.hp=s.mx; s.sta=100; s.foc=0
        s.r=0; s.cd={}; s.buf={}; s.dots=[]; s.last=None; s.shield=0; s.clones=0; s.clT=0; s.mark=None
        s.cats=0; s.catT=0; s.frenzy=0; s.backdraft=False; s.cc=False; s.karma=0; s.karmaPool=0
    def q(s): return max(0,min(1,random.gauss(s.sk,0.15)))
def deal(a,d,mult,t,direct=True,src=None):
    dmg=U*mult*DM[a.c]
    if a.buf.get('enrage',0)>0: dmg*=1+P['enrage']
    if a.buf.get('spree',0)>0: dmg*=1.25
    if t>12: dmg*=1+0.15*(t-12)
    if direct and d.sta>=15 and random.random()<0.15+0.35*d.sk:
        d.sta-=15; dmg*=0.4
    if t<=12: dmg=min(dmg,CAP*d.mx)
    if d.c=='monk' and d.buf.get('jit',0)>0: dmg*=0.7
    if d.karma>0:
        ref=min(dmg*0.5, 0.2*a.mx-d.karmaPool); ref=max(ref,0); d.karmaPool+=ref; a.hp-=ref; dmg*=0.5
    if d.mark is not None and False: pass
    if a.mark is not None: pass
    if d.mark is not None: d.mark[1]+=0.25*dmg
    if d.shield>0:
        ab=min(d.shield,dmg); d.shield-=ab; dmg-=ab
    d.hp-=dmg
    if d.c=='bers': d.r=min(100,d.r+dmg/d.mx*100)
    if a.c=='monk': heal(a,dmg*0.05)
    d.foc=min(100,d.foc+8)
    return dmg
def heal(a,x): a.hp=min(a.mx,a.hp+x*HEAL*(0.7 if a.buf.get('antiheal',0)>0 else 1))
def debuffs(d): return len(d.dots)+(1 if d.buf.get('antiheal',0)>0 else 0)+(1 if d.mark else 0)
def ready(a,k): return a.cd.get(k,0)<=0
def act(a,d,t):
    a.foc=min(100,a.foc+P['focgain'])
    c=a.c
    if a.foc>=100:
        a.foc=0; q=a.q(); ult(a,d,t,q); return
    m=1.0
    def hit(x,direct=True):
        dm=x*(1.08 if (c=='monk' and a.last!=k) else 1)
        r=deal(a,d,dm,t,direct)
        if c=='monk' and a.clT>0 and a.clones: deal(a,d,dm*P['clone']*a.clones,t,direct)
        return r
    k=None
    if c=='bers':
        if d.hp<0.25*d.mx and a.r>=30: k='fired'; a.r-=30; hit(P['fired'])
        elif a.r>=80: k='rq'; a.r-=80; [hit(P['rq']) for _ in range(4)]; a.buf['enrage']=2
        elif ready(a,'bt') and a.sta>=15: k='bt'; a.sta-=15; hit(1.1); heal(a,0.03*a.mx); a.r+=10; a.cd['bt']=1; (random.random()<0.3) and a.buf.__setitem__('enrage',2)
        elif a.sta>=10: k='kb'; a.sta-=10; hit(0.9*(1.2 if a.buf.get('enrage',0)>0 else 1)); a.r+=12
        else: k='br'; a.sta=min(100,a.sta+40)
        a.r=min(100,a.r)
    elif c=='burn':
        if a.hp<0.5*a.mx and ready(a,'sick'): k='sick'; a.hp-=0.05*a.mx; a.shield=P['sick']*a.mx; a.cd['sick']=5
        elif a.r>=2: k='nuke'; a.r-=2; hit(P['nuke'])
        elif not d.dots and ready(a,'tox') and a.sta>=15 and debuffs(d)<2: k='tox'; a.sta-=15; d.dots.append([4,P['tox'],a]); a.cd['tox']=3
        elif d.dots and ready(a,'esc'): k='esc'; hit(1.0); a.r+=1; a.backdraft=True; a.cd['esc']=3
        elif a.sta>=15: k='hot'; a.sta-=15; hit(1.0*(1.3 if a.backdraft else 1)); a.backdraft=False; a.r+=1
        else: k='br'; a.sta=min(100,a.sta+40)
        a.r=min(5,a.r)
    elif c=='excel':
        if a.cc: k='auto'; a.cc=False; [hit(P['auto'],False) for _ in range(3)]
        elif a.r>=4 or (a.r>=2 and a.sta<25): k='bar'; hit(0.6+P['barc']*a.r); a.sta+=5*a.r; a.r=0
        elif a.sta>=15*(1+0.25*a.r): k='sum'; a.sta-=15*(1+0.25*a.r); hit(1.0*(1+0.15*a.r)); a.r+=1; a.cc=random.random()<0.2
        elif ready(a,'save'): k='save'; a.sta=min(100,a.sta+60); a.r=0; a.cd['save']=5
        else: k='br'; a.sta=min(100,a.sta+40)
    elif c=='monk':
        if ready(a,'karma') and a.hp<0.6*a.mx: k='karma'; a.karma=2; a.karmaPool=0; a.cd['karma']=7
        elif a.r>=3 and ready(a,'fof'): k='fof'; a.r-=3; a.buf['jit']=1; [hit(P['fof']) for _ in range(4)]; a.cd['fof']=3
        elif a.r>=2 and ready(a,'rsk') and a.last!='rsk': k='rsk'; a.r-=2; hit(1.3); a.cd['rsk']=2; (debuffs(d)<2) and d.buf.__setitem__('antiheal',2)
        elif a.r>=1 and a.last!='nap': k='nap'; a.r-=1; hit(0.9); a.cd['rsk']=a.cd.get('rsk',0)-1
        elif a.sta>=10: k='sip'; a.sta-=10; hit(0.6); a.r+=2
        else: k='br'; a.sta=min(100,a.sta+40)
        a.r=min(5,a.r)
        if a.clT>0: a.clT-=1
    elif c=='hunt':
        a.r=min(100,a.r+10)
        if ready(a,'spree'): k='spree'; a.buf['spree']=2; a.cd['spree']=6
        elif ready(a,'cold') and debuffs(d)<2: k='cold'; d.dots.append([3,P['cold'],a]); a.r+=20; a.frenzy=min(3,a.frenzy+1); a.cd['cold']=2
        elif ready(a,'sic') and a.r>=30: k='sic'; a.r-=30; deal(a,d,P['sic']*(1+0.08*a.frenzy),t,False); a.cd['sic']=1
        elif a.r>=35: k='ping'; a.r-=35; hit(0.8); a.cd['sic']=a.cd.get('sic',0)-1
        else: k='strike'; hit(0.8)
        a.r=min(100,a.r)
    a.last=k
def ult(a,d,t,q):
    c=a.c
    if c=='bers':
        n=round(9*q); [deal(a,d,P['crunch'],t) for _ in range(n)]
        if n>=6: a.buf['enrage']=3
        a.r=min(100,a.r+40)
        if n==9: [deal(a,d,P['rq'],t) for _ in range(4)]
    elif c=='burn': a.intern=1+round(3*q); a.r=min(5,a.r+0)
    elif c=='excel':
        if debuffs(d)<2: d.mark=[2,0,1+0.25*round(4*q),a]
        if round(4*q)==4: a.r=4
    elif c=='monk': a.clones=round(3*q); a.clT=3
    elif c=='hunt':
        a.cats=round(3*q); a.catT=2
        if q>0.9: deal(a,d,P['sic'],t,False)
def tick(a,d,t):
    for x in list(a.dots):
        deal(x[2],a,x[1],t,False)
        if x[2].c=='burn' and random.random()<0.4: x[2].r=min(5,x[2].r+1)
        x[0]-=1
        if x[0]<=0: a.dots.remove(x)
    if a.c=='hunt':
        deal(a,d,P['cat']*(1+0.08*a.frenzy),t,False)
        if a.catT>0: deal(a,d,P['ucat']*a.cats,t,False); a.catT-=1
    if a.c=='burn' and getattr(a,'intern',0)>0: deal(a,d,P['intern'],t,False); a.r=min(5,a.r+1); a.intern-=1
    if d.mark is not None and d.mark[3] is a:
        d.mark[0]-=1
        if d.mark[0]<=0: m=d.mark; d.mark=None; deal(a,d,0,t,False); d.hp-=min(m[1]*m[2],CAP*d.mx)
    if a.c=='bers': a.r=max(0,a.r-5)
    a.sta=min(100,a.sta+15)
    for k in list(a.cd): a.cd[k]-=1
    for k in list(a.buf): a.buf[k]-=1
    if a.karma>0: a.karma-=1
def fight(c1,c2,s1,s2):
    A=F(c1,s1); B=F(c2,s2); order=[A,B] if random.random()<.5 else [B,A]
    for t in range(1,40):
        for x in order:
            y=B if x is A else A
            tick(x,y,t); 
            if y.hp<=0 or x.hp<=0: break
            act(x,y,t)
            if y.hp<=0 or x.hp<=0: break
        if A.hp<=0 or B.hp<=0: break
    return (1 if B.hp<=0 and A.hp>0 else 0 if A.hp<=0 else (1 if A.hp/A.mx>B.hp/B.mx else 0)), t
def main():
    CL=['bers','burn','excel','monk','hunt']
    N=int(sys.argv[1]) if len(sys.argv)>1 else 2000
    s=float(sys.argv[2]) if len(sys.argv)>2 else 0.5
    tot={c:[] for c in CL}; T=[]
    print('      '+' '.join(f'{c:>6}' for c in CL))
    for a in CL:
        row=[]
        for b in CL:
            w=0
            for i in range(N):
                r,t=fight(a,b,s,s); w+=r; T.append(t)
            row.append(w/N); 
            if a!=b: tot[a].append(w/N)
        print(f'{a:>6}'+' '.join(f'{x:6.2f}' for x in row))
    print('avg', {c:round(sum(v)/len(v),3) for c,v in tot.items()}, 'turns', round(sum(T)/len(T),1))
    
if __name__=='__main__': main()
