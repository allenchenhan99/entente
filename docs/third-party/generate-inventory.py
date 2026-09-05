"""Generate license/source inventories; reads locks, writes documentation only.

Python 3.11+, network access to crates.io. Run from the repository root:
    python docs/third-party/generate-inventory.py
No packages are installed or executed. Cargo metadata is checked against the
locked archive checksum. Registry declarations are not a legal compatibility audit.
"""
import concurrent.futures
import json
from pathlib import Path
import time
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent


def cargo_entry(package):
    name, version = package['name'], package['version']
    url = f'https://crates.io/api/v1/crates/{name}/{version}'
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers={
                'User-Agent': 'Entente-license-inventory (https://github.com/allenchenhan99/entente)',
            })
            with urllib.request.urlopen(request, timeout=45) as response:
                metadata = json.load(response)['version']
            if metadata['checksum'] != package['checksum']:
                raise ValueError(f'Checksum mismatch: {name} {version}')
            if not metadata.get('license'):
                raise ValueError(f'Missing declared license: {name} {version}')
            return {
                'name': name, 'version': version,
                'license': metadata['license'],
                'repository': metadata.get('repository'),
                'source': package['source'], 'checksum': package['checksum'],
                'metadata_source': url,
                'download': f'https://crates.io/api/v1/crates/{name}/{version}/download',
            }
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


def main():
    npm = []
    for lock in ['package-lock.json', 'demo-repo/package-lock.json', 'presentation/package-lock.json']:
        packages = json.loads((ROOT / lock).read_text(encoding='utf-8'))['packages']
        for path, package in sorted(packages.items()):
            if 'node_modules/' not in path or package.get('link'):
                continue
            if not package.get('license'):
                raise ValueError(f'Missing declared license: {lock}: {path}')
            npm.append({
                'lockfile': lock, 'path': path,
                'name': package.get('name', path.rsplit('node_modules/', 1)[1]),
                'version': package['version'], 'license': package['license'],
                'source': package.get('resolved'), 'integrity': package.get('integrity'),
            })
    packages = tomllib.loads((ROOT / 'Cargo.lock').read_text(encoding='utf-8'))['package']
    external = sorted((p for p in packages if 'source' in p), key=lambda p: (p['name'], p['version']))
    for package in external:
        if package['source'] != 'registry+https://github.com/rust-lang/crates.io-index':
            raise ValueError(f'Unsupported registry: {package["source"]}')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        cargo = list(pool.map(cargo_entry, external))
    # Write only after all lookups and validations succeed.
    for name, entries in [('npm-dependencies.json', npm), ('cargo-dependencies.json', cargo)]:
        (OUT / name).write_text(json.dumps(entries, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(f'{name}: {len(entries)} dependency entries', flush=True)


if __name__ == '__main__':
    main()
