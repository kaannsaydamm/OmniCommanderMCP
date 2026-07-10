#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const staging = join(root, '.omni');
const expectedBase64Bytes = 109_992;
const expectedArchiveBytes = 82_492;
const expectedSha256 = 'a15ba5bd2ca3e39449f9f1e984694ab4bdb2b825f4b296f618ecf97d2bdef9ff';

const chunks = Array.from({ length: 7 }, (_, index) => join(staging, `chunk-${String(index).padStart(2, '0')}`));
for (const chunk of chunks) {
  if (!existsSync(chunk)) throw new Error(`Missing staged source chunk: ${chunk}`);
}

const encoded = chunks.map((chunk) => readFileSync(chunk, 'utf8').trim()).join('');
if (Buffer.byteLength(encoded, 'utf8') !== expectedBase64Bytes) {
  throw new Error(`Staged source length mismatch: expected ${expectedBase64Bytes}, got ${Buffer.byteLength(encoded, 'utf8')}`);
}

const archive = Buffer.from(encoded, 'base64');
if (archive.length !== expectedArchiveBytes) {
  throw new Error(`Archive length mismatch: expected ${expectedArchiveBytes}, got ${archive.length}`);
}
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== expectedSha256) throw new Error(`Archive checksum mismatch: expected ${expectedSha256}, got ${digest}`);

const temporaryDirectory = join(root, '.omni-materialize');
const archivePath = join(temporaryDirectory, 'source.tar.gz');
mkdirSync(temporaryDirectory, { recursive: true });
writeFileSync(archivePath, archive);

const result = spawnSync('tar', ['-xzf', archivePath, '-C', root], { cwd: root, stdio: 'inherit', windowsHide: true });
rmSync(temporaryDirectory, { recursive: true, force: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`tar exited with status ${result.status}`);

const packagePath = join(root, 'package.json');
if (!existsSync(packagePath) || JSON.parse(readFileSync(packagePath, 'utf8')).version !== '0.2.0') {
  throw new Error('Materialized tree failed package version verification.');
}

console.log('Omni Commander 0.2.0 source tree materialized and SHA-256 verified.');
