import json
import os
import zipfile

root = r'C:\Users\Winfos\Documents\BalnaSkip\extension'
outdir = r'C:\Users\Winfos\Documents\BalnaSkip\dist'
os.makedirs(outdir, exist_ok=True)

with open(os.path.join(root, 'manifest.json'), encoding='utf-8') as f:
    manifest = json.load(f)
version = manifest['version']
out = os.path.join(outdir, 'balnaskip-sulytalan-%s.xpi' % version)

with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for base, dirs, files in os.walk(root):
        dirs.sort()
        for name in sorted(files):
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root).replace('\\', '/')
            z.write(path, rel)

print(out, os.path.getsize(out))
