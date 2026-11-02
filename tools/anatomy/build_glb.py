"""Decimate every part to its budget and write public/models/anatomy.glb (one named mesh per part).
usage: python3 build_glb.py decimate <parts...> | python3 build_glb.py write"""
import numpy as np, json, struct, sys, os, time
from decimate import decimate
T = dict(skin=26000, brain=30000, heart=18000, valves=2400, coronary=3550, cardiac_veins=1564, bronchi=16000, lung_r=9000, lung_l=8000,
         airway=4000, thyroid=2500, arteries=9000, veins=6500, esophagus=1300, liver=9000, gallbladder=1500, hepatic_veins=5000,
         portal_vein=4000, bile_ducts=958, stomach=6000, spleen=3000, pancreas=5000, kidneys=10000, kidney_medulla=6000,
         kidney_pelvis=4000, adrenals=1500, bladder=3000, colon=9000, small_int=5986, diaphragm=6000, skel_axial=20000,
         skel_limbs=9000, ribs=9000, cartilage=3000)
os.makedirs('dec', exist_ok=True)

def normals(v, t):
    n = np.zeros_like(v)
    fn = np.cross(v[t[:, 1]] - v[t[:, 0]], v[t[:, 2]] - v[t[:, 0]])
    for k in range(3): np.add.at(n, t[:, k], fn)
    return (n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)).astype(np.float32)

def write(out):
    bufs = []; views = []; accs = []; meshes = []; nodes = []; off = 0
    def add(arr, target, comp, typ, minmax=False):
        nonlocal off
        b = arr.tobytes(); pad = (-len(b)) % 4
        bufs.append(b + b'\0' * pad)
        views.append(dict(buffer=0, byteOffset=off, byteLength=len(b), target=target)); off += len(b) + pad
        a = dict(bufferView=len(views) - 1, componentType=comp, count=int(arr.shape[0]) if arr.ndim > 1 else int(arr.size), type=typ)
        if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
        accs.append(a); return len(accs) - 1
    for pid in T:
        d = np.load(f'dec/{pid}.npz'); v = d['v'].astype(np.float32); t = d['t'].astype(np.int64)
        idx = t.astype(np.uint16 if len(v) < 65536 else np.uint32).reshape(-1)
        ip = add(v, 34962, 5126, 'VEC3', True); inn = add(normals(v.astype(np.float64), t), 34962, 5126, 'VEC3')
        ii = add(idx, 34963, 5123 if idx.dtype == np.uint16 else 5125, 'SCALAR')
        meshes.append(dict(name=pid, primitives=[dict(attributes=dict(POSITION=ip, NORMAL=inn), indices=ii, mode=4)]))
        nodes.append(dict(name=pid, mesh=len(meshes) - 1))
    blob = b''.join(bufs)
    gltf = dict(asset=dict(version='2.0', generator='LotusPond anatomy builder'), scene=0, scenes=[dict(name='anatomy', nodes=list(range(len(nodes))))],
                nodes=nodes, meshes=meshes, accessors=accs, bufferViews=views, buffers=[dict(byteLength=len(blob))])
    js = json.dumps(gltf, separators=(',', ':')).encode(); js += b' ' * ((-len(js)) % 4)
    with open(out, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(blob), 0x004E4942)); f.write(blob)
    print('wrote', out, os.path.getsize(out), 'bytes;', sum(int(np.load(f"dec/{p}.npz")['v'].shape[0]) for p in T), 'verts')

if __name__ == '__main__':
    if sys.argv[1] == 'write': write(sys.argv[2] if len(sys.argv) > 2 else 'anatomy_raw.glb'); sys.exit()
    for pid in sys.argv[2:]:
        t0 = time.time(); d = np.load(f'parts/{pid}.npz')
        v, t = decimate(d['v'], d['t'], T[pid])
        np.savez(f'dec/{pid}.npz', v=v.astype(np.float32), t=t.astype(np.int32))
        print(f'{pid:<14} {len(d["v"]):6d} -> {len(v):6d}  {time.time()-t0:.1f}s', flush=True)
