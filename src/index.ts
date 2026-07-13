#!/usr/bin/env node
import { runHttp } from './http.js';
import { runStdio } from './server.js';

const argv = process.argv.slice(2);
const transport = argv.includes('--http') || argv.includes('--transport=http') ? 'http' : 'stdio';

(transport === 'http' ? runHttp(argv) : runStdio(argv)).catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[omni-commander] fatal: ${message}\n`);
  process.exitCode = 1;
});
