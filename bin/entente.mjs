#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'apps/launcher/dist/index.js');
const source = path.join(root, 'apps/launcher/src/index.ts');
const entry = existsSync(dist) ? [dist] : ['--import', 'tsx', source];
const child = spawn(process.execPath, [...entry, ...process.argv.slice(2)], { stdio: 'inherit' });

const forwardInt = () => { child.kill('SIGINT'); };
const forwardTerm = () => { child.kill('SIGTERM'); };
const cleanup = () => {
  process.off('SIGINT', forwardInt);
  process.off('SIGTERM', forwardTerm);
};

process.on('SIGINT', forwardInt);
process.on('SIGTERM', forwardTerm);
child.once('error', (error) => {
  cleanup();
  process.stderr.write(`entente: ${error.message}\n`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
