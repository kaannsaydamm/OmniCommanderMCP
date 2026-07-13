import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, loadConfig } from '../src/config.js';
import { PolicyEngine, PolicyError } from '../src/policy.js';

const temporaryPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-test-'));
  temporaryPaths.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe('configuration and policy', () => {
  it('uses bounded profile-specific watch event limits', async () => {
    const base = await makeTempDir();
    const safe = await loadConfig([`--config=${path.join(base, 'safe.json')}`, '--safe']);
    const full = await loadConfig([`--config=${path.join(base, 'full.json')}`, '--full']);

    expect(safe.maxWatchEvents).toBe(10_000);
    expect(full.maxWatchEvents).toBe(100_000);
  });

  it('enforces allowed roots in safe mode', async () => {
    const base = await makeTempDir();
    const allowed = path.join(base, 'allowed');
    const denied = path.join(base, 'denied');
    await fs.mkdir(allowed, { recursive: true });
    await fs.mkdir(denied, { recursive: true });
    const config = await loadConfig([`--config=${path.join(base, 'config.json')}`, '--safe']);
    const store = new ConfigStore(config);
    await store.update({ allowedRoots: [allowed] }, false);
    const policy = new PolicyEngine(store);

    await expect(policy.assertPath(path.join(allowed, 'new.txt'))).resolves.toContain('new.txt');
    await expect(policy.assertPath(path.join(denied, 'blocked.txt'))).rejects.toBeInstanceOf(PolicyError);
  });

  it('resets profile-specific restrictions when switching to full', async () => {
    const base = await makeTempDir();
    const config = await loadConfig([`--config=${path.join(base, 'config.json')}`, '--safe']);
    const store = new ConfigStore(config);
    await store.update({ profile: 'full' }, false);

    expect(store.get().profile).toBe('full');
    expect(store.get().allowedRoots).toEqual([]);
    expect(store.get().blockedCommandPatterns).toEqual([]);
    expect(store.get().allowPrivateNetwork).toBe(true);
    expect(store.get().allowEnvironmentRead).toBe(true);
  });

  it('blocks destructive command patterns only in safe profile', async () => {
    const base = await makeTempDir();
    const config = await loadConfig([`--config=${path.join(base, 'config.json')}`, '--safe']);
    const store = new ConfigStore(config);
    const policy = new PolicyEngine(store);

    expect(() => policy.assertCommand('rm -rf /')).toThrow(PolicyError);
    expect(() => policy.assertCommand('echo hello')).not.toThrow();

    await store.update({ profile: 'full' }, false);
    expect(() => policy.assertCommand('rm -rf /')).not.toThrow();
  });
});
