"""Download the inventoried HiRISE products and record reproducible local hashes."""

import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config/columbia-hills/sources.json'
RAW = ROOT / 'data/raw/columbia-hills'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    inventory = json.loads(CONFIG.read_text())
    RAW.mkdir(parents=True, exist_ok=True)
    for product in inventory['products']:
        target = RAW / product['filename']
        if target.name != product['filename']:
            raise ValueError('Product filenames must not contain directories')
        if not target.exists():
            partial = target.with_suffix(target.suffix + '.part')
            print(f'Downloading {target.name}', flush=True)
            subprocess.run([
                'curl', '--fail', '--location', '--retry', '3', '--connect-timeout', '30',
                '--max-time', '1800', '--continue-at', '-', '--output', str(partial),
                product['url'],
            ], check=True)
            if partial.stat().st_size != product['catalogueBytes']:
                raise ValueError(f'Unexpected size for {target.name}: {partial.stat().st_size}')
            partial.rename(target)
        if target.stat().st_size != product['catalogueBytes']:
            raise ValueError(f'Unexpected size for {target.name}')
        digest = sha256(target)
        if product.get('sha256') and product['sha256'] != digest:
            raise ValueError(f'Checksum changed for {target.name}')
        product['sha256'] = digest
        product['verifiedBytes'] = target.stat().st_size
        product.setdefault('retrievedAt', datetime.now(timezone.utc).isoformat())
        print(f'Verified {target.name}: {digest}', flush=True)
    for reference in inventory.get('references', []):
        if not reference.get('assetUrl'):
            continue
        target = RAW / reference['filename']
        if not target.resolve().is_relative_to(RAW.resolve()):
            raise ValueError('Reference path escapes the source directory')
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            temporary = target.with_suffix(target.suffix + '.part')
            subprocess.run(['curl', '--fail', '--location', '--retry', '3', '--max-time', '180',
                            '--output', str(temporary), reference['assetUrl']], check=True)
            digest = sha256(temporary)
            if reference.get('sha256') and reference['sha256'] != digest:
                raise ValueError(f'Reference changed upstream: {target.name}; review before replacing')
            temporary.rename(target)
        digest = sha256(target)
        if reference.get('sha256') and reference['sha256'] != digest:
            raise ValueError(f'Reference checksum mismatch: {target.name}')
        reference['sha256'] = digest
        reference['verifiedBytes'] = target.stat().st_size
        reference.setdefault('retrievedAt', datetime.now(timezone.utc).isoformat())
        print(f'Verified reference {target.name}: {digest}', flush=True)
    inventory['credits'] = 'NASA/JPL-Caltech/University of Arizona; DTM produced by USGS'
    CONFIG.write_text(json.dumps(inventory, indent=2) + '\n')
    (CONFIG.parent / 'sources.sha256').write_text(''.join(
        f"{p['sha256']}  data/raw/columbia-hills/{p['filename']}\n"
        for p in [*inventory['products'], *inventory.get('references', [])] if p.get('sha256')
    ))


if __name__ == '__main__':
    main()
