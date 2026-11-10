
import json, os
from PIL import Image
src = "/workspace/miushi-yuanqi/wallpapers"
out = "/workspace/miushi-yuanqi/assets/wallpapers-720"
os.makedirs(out, exist_ok=True)
rep = []
for i in range(1, 18):
    name = f"wp{i:02d}.jpg"
    im = Image.open(os.path.join(src, name)).convert("RGB")
    w, h = im.size
    nw = 720
    nh = round(h * nw / w)
    im2 = im.resize((nw, nh), Image.LANCZOS)
    p = os.path.join(out, name)
    im2.save(p, "JPEG", quality=78, optimize=True, progressive=True)
    rep.append({"name": name, "orig": [w,h], "new": [nw,nh], "bytes": os.path.getsize(p)})
total = sum(r["bytes"] for r in rep)
print(json.dumps({"items": rep, "total_bytes": total, "base64_est": round(total*4/3)}, ensure_ascii=False, indent=1))
