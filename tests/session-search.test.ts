import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, loadConfig } from '../src/config.js';
import { SessionManager } from '../src/managers/session-manager.js';
import { SearchManager } from '../src/managers/search-manager.js';
import { PolicyEngine } from '../src/policy.js';

const temporaryPaths: string[] = [];

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-test-'));
  temporaryPaths.push(base);
  const config = await loadConfig([`--config=${path.join(base, 'config.json')}`, '--full']);
  const store = new ConfigStore(config);
  const policy = new PolicyEngine(store);
  return { base, store, policy };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe('sessions and search', () => {
  it('captures output from a managed process', async () => {
    const { store, policy } = await setup();
    const sessions = new SessionManager(store, policy);
    const command = `"${process.execPath}" -e "console.log('omni-ok')"`;
    const started = await sessions.start({ command });
    const id = String(started.id);

    let current = sessions.read(id, 0, 10_000);
    for (let i = 0; i < 100 && current.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      current = sessions.read(id, 0, 10_000);
    }

    expect(current.status).not.toBe('running');
    expect(String(current.output)).toContain('omni-ok');
  });

  it('searches names and contents recursively', async () => {
    const { base, store, policy } = await setup();
    await fs.mkdir(path.join(base, 'src'), { recursive: true });
    await fs.writeFile(path.join(base, 'src', 'alpha.ts'), 'export const sentinel = 42;\n');
    await fs.writeFile(path.join(base, 'readme.md'), 'nothing here\n');
    const search = new SearchManager(store, policy);

    const byName = await search.search({ root: base, query: 'alpha', mode: 'name' });
    expect(JSON.stringify(byName)).toContain('alpha.ts');

    const byContent = await search.search({ root: base, query: 'sentinel', mode: 'content', extensions: ['ts'] });
    expect(JSON.stringify(byContent)).toContain('sentinel');
  });
});
