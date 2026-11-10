from PIL import Image, ImageDraw, ImageFont
import json, os, colorsys
OUT='shots/phase-c2'
try: font30=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',30)
except: font30=None
try: font17=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',17)
except: font17=None
def fit(im,h): return im.resize((round(im.width*h/im.height),h), Image.LANCZOS)
def label(c,xy,text,font=None,fill=(60,70,80)):
    ImageDraw.Draw(c).text(xy,text,font=font or font17,fill=fill)

# ---------- 1) 参考图 vs C2 首页 ----------
ref=Image.open('ref/glass-target-our-tide.jpg').convert('RGB'); H=1688; r=fit(ref,H)
for theme,lab in [('ice','ICE HOME (C2)'),('pink','PINK HOME (C2)')]:
    o=fit(Image.open(f'{OUT}/{theme}-home.png').convert('RGB'),H)
    pad=16; L=54
    c=Image.new('RGB',(r.width+o.width+pad*3,H+L+pad),(245,245,247))
    c.paste(r,(pad,L)); c.paste(o,(pad*2+r.width,L))
    label(c,(pad,12),'REFERENCE  glass-target-our-tide',font30)
    label(c,(pad*2+r.width,12),lab,font30)
    c.save(f'{OUT}/compare-target-vs-{theme}-home.png'); print('compare-target-vs-'+theme,c.size)

# ---------- 2) C1 vs C2 首页 ----------
for theme in ['ice','pink']:
    a=fit(Image.open(f'shots/phase-c1-r3/{theme}-home.png').convert('RGB'),H)
    b=fit(Image.open(f'{OUT}/{theme}-home.png').convert('RGB'),H)
    pad=16; L=54
    c=Image.new('RGB',(a.width+b.width+pad*3,H+L+pad),(245,245,247))
    c.paste(a,(pad,L)); c.paste(b,(pad*2+a.width,L))
    label(c,(pad,12),theme.upper()+' HOME  C1 (r3)  final',font30)
    label(c,(pad*2+a.width,12),theme.upper()+' HOME  C2',font30)
    c.save(f'{OUT}/compare-c1-vs-c2-{theme}-home.png'); print('compare-c1-vs-c2-'+theme,c.size)

# ---------- 3) 景物测试：每张首页 4 个卡片内部 ×2 ----------
metrics=json.load(open(f'{OUT}/_metrics.json'))
scenery={}
for theme in ['ice','pink']:
    m=metrics['themes'][theme]
    img=Image.open(f'{OUT}/{theme}-home.png').convert('RGB')
    keys=['couple','clock','note','player']
    crops=[]
    scenery[theme]={}
    for key in keys:
        rr=m['cards'][key]
        x0=max(0,round((rr['x']+10)*2)); y0=max(0,round((rr['y']+10)*2))
        x1=min(img.width,round((rr['x']+rr['w']-10)*2)); y1=min(img.height,round((rr['y']+rr['h']-10)*2))
        cc=img.crop((x0,y0,x1,y1)); cc=cc.resize((cc.width*2,cc.height*2), Image.LANCZOS)
        fn=f'scenery-{theme}-{key}.png'; cc.save(f'{OUT}/{fn}')
        crops.append((key,cc)); scenery[theme][key]={'file':fn,'w':cc.width,'h':cc.height}
    W=sum(c.width for _,c in crops)+8*(len(crops)+1); Hh=max(c.height for _,c in crops)+30
    strip=Image.new('RGB',(W,Hh),(245,245,247)); x=8
    for k,cc in crops:
        strip.paste(cc,(x,28)); label(strip,(x,4),f'{theme} · {k} 内部 ×2',fill=(120,0,0)); x+=cc.width+8
    strip.save(f'{OUT}/scenery-{theme}-strip.jpg',quality=92); print('scenery-strip',theme,strip.size)
json.dump(scenery,open(f'{OUT}/_scenery-crops.json','w'),ensure_ascii=False,indent=2)

# ---------- 4) 实测对比度（computed 字色 vs 截图取样的局部背景） ----------
def lum(rgb):
    def f(v):
        v=v/255.0
        return v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4
    return 0.2126*f(rgb[0])+0.7152*f(rgb[1])+0.0722*f(rgb[2])
def parse_rgb(s):
    s=s.strip()
    if s.startswith('rgba') or s.startswith('rgb'):
        parts=s[s.index('(')+1:s.index(')')].split(',');
        return tuple(float(x) for x in parts[:3])
    return (0,0,0)
def median(v):
    v=sorted(v); n=len(v)
    return v[n//2] if n else 0
def bg_lum(img, box):
    x0=int(box['x']*2); y0=int(box['y']*2); x1=int((box['x']+box['w'])*2); y1=int((box['y']+box['h'])*2)
    samples=[]
    for (sx0,sy0,sx1,sy1) in [(x0,y0-14,x1,y0-3),(x0,y1+3,x1,y1+14),(x0-14,y0,x0-3,y1),(x1+3,y0,x1+14,y1)]:
        sx0=max(0,sx0); sy0=max(0,sy0); sx1=min(img.width,sx1); sy1=min(img.height,sy1)
        if sx1<=sx0 or sy1<=sy0: continue
        samples.extend(lum(p) for p in img.crop((sx0,sy0,sx1,sy1)).getdata())
    return median(samples) if samples else None
def nearest_card(theme, box):
    m=metrics['themes'][theme]
    cx=box['x']+box['w']/2; cy=box['y']+box['h']/2
    best=None; bestd=1e9
    for name,rr in m['cards'].items():
        if rr and rr['x']<=cx<=rr['x']+rr['w'] and rr['y']<=cy<=rr['y']+rr['h']:
            d=(cx-(rr['x']+rr['w']/2))**2+(cy-(rr['y']+rr['h']/2))**2
            if d<bestd: bestd=d; best=name
    return best or '-'
results=[]
pages=['home','chat','memory','listen','me','stats','characters','settings']
for theme in ['ice','pink']:
    m=metrics['themes'][theme]
    for page in pages:
        boxes=m.get('pageBoxes',{}).get(page,[])
        path=f'{OUT}/{theme}-home.png' if page=='home' else f'{OUT}/{theme}-{page}.png'
        if not os.path.exists(path): continue
        img=Image.open(path).convert('RGB')
        for b in boxes:
            if b['y']<32 or b['y']+b['h']>760: continue
            bl=bg_lum(img,b)
            if bl is None: continue
            tl=lum(parse_rgb(b['color']))
            hi,lo=max(bl,tl),min(bl,tl)
            cr=round((hi+0.05)/(lo+0.05),2)
            results.append({'theme':theme,'page':page,'card':nearest_card(theme,b) if page=='home' else '-','text':b['text'][:26],'fs':b['fs'],'color':b['color'],'bgLum':round(bl,3),'contrast':cr})
json.dump(results,open(f'{OUT}/_contrast.json','w'),ensure_ascii=False,indent=2)
print('contrast samples:',len(results))
worst=sorted(results,key=lambda r:r['contrast'])[:10]
for w in worst: print('  worst',w['theme'],w['page'],w['card'],w['fs'],w['contrast'],w['text'])
by_page={}
for r_ in results:
    k=(r_['theme'],r_['page'])
    by_page[k]=min(by_page.get(k,99), r_['contrast'])
print('min contrast by page:')
for k in sorted(by_page): print('  ',k,by_page[k])
print('TOTAL MIN', min(r_['contrast'] for r_ in results))