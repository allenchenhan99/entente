#!/usr/bin/env node
import { runLauncher } from './launcher.js';

void runLauncher(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`entente: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
