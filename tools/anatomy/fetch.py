"""Download the pinned anatomy sources (tools/anatomy/sources.json) into tools/anatomy/.cache/src/ and verify them.

  python3 tools/anatomy/fetch.py [--reuse hra=/path/to/ccf-releases --reuse zanatomy=/path/to/Z-Anatomy]

Each repository is cloned blobless at its pinned commit and only the listed files are checked out, so the download is
the size of those files (about 170 MB each), not the whole history. --reuse points at an existing clone instead.
Archives are unpacked next to themselves; the 7z archive needs `pip install py7zr`.
"""
import hashlib, json, os, subprocess, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache', 'src')
SOURCES = json.load(open(os.path.join(HERE, 'sources.json')))


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''): h.update(chunk)
    return h.hexdigest()


def git(*args, cwd=None):
    env = dict(os.environ, GIT_LFS_SKIP_SMUDGE='1')
    subprocess.run(['git', *args], cwd=cwd, check=True, env=env)


def ensure_clone(name, src, reuse):
    dest = os.path.join(CACHE, name)
    if name in reuse:
        if not os.path.exists(dest):
            os.makedirs(CACHE, exist_ok=True); os.symlink(os.path.abspath(reuse[name]), dest)
        return dest
    if not os.path.isdir(os.path.join(dest, '.git')):
        os.makedirs(CACHE, exist_ok=True)
        git('clone', '--filter=blob:none', '--no-checkout', src['repo'], dest)
    try:
        git('cat-file', '-e', src['commit'] + '^{commit}', cwd=dest)
    except subprocess.CalledProcessError:
        git('fetch', '--filter=blob:none', 'origin', src['commit'], cwd=dest)
    return dest


def main():
    reuse = {}
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == '--reuse': k, v = argv[i + 1].split('=', 1); reuse[k] = v
    for name, src in SOURCES.items():
        if not isinstance(src, dict) or 'repo' not in src: continue
        dest = ensure_clone(name, src, reuse)
        for key, f in src['files'].items():
            path = os.path.join(dest, f['path'])
            if not os.path.exists(path) or sha256(path) != f['sha256']:
                git('checkout', src['commit'], '--', f['path'], cwd=dest)
            got = sha256(path)
            if got != f['sha256']: sys.exit(f'{name}/{key}: checksum mismatch for {f["path"]}: {got}')
            if 'member' in f:
                out = os.path.join(os.path.dirname(path), f['member'])
                if not os.path.exists(out) or sha256(out) != f['memberSha256']:
                    if path.endswith('.zip'):
                        with zipfile.ZipFile(path) as z: z.extract(f['member'], os.path.dirname(path))
                    elif path.endswith('.7z'):
                        import py7zr
                        with py7zr.SevenZipFile(path) as z: z.extract(os.path.dirname(path), targets=[f['member']])
                    if sha256(out) != f['memberSha256']: sys.exit(f'{name}/{key}: checksum mismatch for {f["member"]}')
            print(f'ok  {name}/{key}', flush=True)


if __name__ == '__main__':
    main()
