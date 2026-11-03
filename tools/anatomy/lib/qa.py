"""Render QA images of meshes from Python (wraps tools/anatomy/qa/render.mjs).

    from lib.qa import render
    render([dict(mesh=(v, f), color='#c33'), ...], 'out.png', dir=(0, 0, 1))
    render_views([...meshes...], {'front': dict(dir=(0, 0, 1)), 'left': dict(dir=(1, 0, 0))}, 'out_dir/prefix')
"""
import json, os, subprocess, tempfile, hashlib
import numpy as np

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(os.path.dirname(HERE))
TMP = os.path.join(HERE, '.cache', 'qa-tmp')


def _write_mesh(v, f):
    os.makedirs(TMP, exist_ok=True)
    v = np.asarray(v, np.float32); f = np.asarray(f, np.uint32)
    h = hashlib.sha1(v.tobytes()[:1 << 20] + f.tobytes()[:1 << 20] + str((v.shape, f.shape)).encode()).hexdigest()[:16]
    pos, idx = os.path.join(TMP, h + '.pos'), os.path.join(TMP, h + '.idx')
    if not os.path.exists(pos): v.tofile(pos); f.tofile(idx)
    return pos, idx


def _mesh_entries(items):
    out = []
    for it in items:
        v, f = it['mesh']
        if not len(f): continue
        pos, idx = _write_mesh(v, f)
        out.append(dict(pos=pos, idx=idx, color=it.get('color', '#cccccc'), opacity=it.get('opacity', 1.0)))
    return out


def render_views(items, cams, prefix, size=(900, 700), clip=None, title=None):
    """One PNG per camera: prefix + '-' + name + '.png'. Returns the file paths."""
    meshes = _mesh_entries(items)
    views = []
    for name, cam in cams.items():
        cam = dict(cam); c = cam.pop('clip', clip)
        views.append(dict(out=os.path.abspath(f'{prefix}-{name}.png'), meshes=meshes, camera={k: (list(map(float, x)) if isinstance(x, (tuple, list, np.ndarray)) else x) for k, x in cam.items()},
                          clip=[dict(normal=list(map(float, p['normal'])), constant=float(p['constant'])) for p in (c or [])]))
    spec = dict(width=size[0], height=size[1], views=views)
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, dir=TMP if os.path.isdir(TMP) else None) as fh:
        json.dump(spec, fh); path = fh.name
    subprocess.run(['node', os.path.join(HERE, 'qa', 'render.mjs'), path], check=True, cwd=ROOT, stdout=subprocess.DEVNULL)
    os.unlink(path)
    return [v['out'] for v in views]


def render(items, out, size=(900, 700), clip=None, **cam):
    prefix = out[:-4] if out.endswith('.png') else out
    files = render_views(items, {'v': cam}, prefix, size=size, clip=clip)
    os.replace(files[0], out if out.endswith('.png') else out + '.png')
    return out


FRONT = dict(dir=(0, 0.02, 1)); BACK = dict(dir=(0, 0.02, -1)); LEFT = dict(dir=(1, 0.02, 0)); RIGHT = dict(dir=(-1, 0.02, 0))
TOP = dict(dir=(0, 1, 0.001), up=(0, 0, -1)); BOTTOM = dict(dir=(0, -1, 0.001), up=(0, 0, 1))
