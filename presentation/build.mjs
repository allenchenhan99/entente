import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, 'dist');
if (path.dirname(output) !== root || path.basename(output) !== 'dist') {
  throw new Error('Build output must be presentation/dist');
}
const html = await readFile(path.join(root, 'index.html'), 'utf8');
const slides = [...html.matchAll(/data-slide="(\d+)"/g)].map(m => Number(m[1]));
if (slides.join(',') !== '0,1,2,3,4,5,6' || !html.includes('Atrophied Intelligence')) {
  throw new Error('Expected the approved seven-slide pitch');
}
for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  new Script(script);
}
for (const [, asset] of html.matchAll(/(?:src|href)="\/entente\/([^"?#]+)"/g)) {
  const assetPath = path.resolve(root, 'public', asset);
  if (!assetPath.startsWith(path.join(root, 'public') + path.sep)) throw new Error('Invalid asset path');
  await access(assetPath);
}
// The resolved output above is confined to this project's generated dist directory.
await rm(output, { recursive: true, force: true });
await mkdir(output);
await cp(path.join(root, 'public'), output, { recursive: true });
const revision = process.env.GITHUB_SHA || 'local';
if (!/^(?:[0-9a-f]{40}|local)$/.test(revision)) throw new Error('Invalid deployment revision');
await writeFile(path.join(output, 'index.html'), html.replace('</head>', `<meta name="deployment-revision" content="${revision}">\n</head>`));
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Built seven-slide pitch only; inline JavaScript and image references verified.');
