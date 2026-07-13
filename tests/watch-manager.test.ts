import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, loadConfig } from '../src/config.js';
import { WatchManager, type WatchEventPage } from '../src/managers/watch-manager.js';
import { PolicyEngine, PolicyError } from '../src/policy.js';

const temporaryPaths: string[] = [];
const managers: WatchManager[] = [];

async function makeTempDir(): Promise<string> {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-watch-'));
  temporaryPaths.push(value);
  return value;
}

async function setup(profile: 'safe' | 'full' = 'full') {
  const base = await makeTempDir();
  const config = await loadConfig([`--config=${path.join(base, 'config.json')}`, `--${profile}`]);
  const store = new ConfigStore(config);
  const policy = new PolicyEngine(store);
  const manager = new WatchManager(store, policy);
  managers.push(manager);
  return { base, store, policy, manager };
}

async function waitFor(
  manager: WatchManager,
  id: string,
  predicate: (page: WatchEventPage) => boolean,
  timeoutMs = 5_000
): Promise<WatchEventPage> {
  const deadline = Date.now() + timeoutMs;
  let page = manager.read(id, 0, 1_000);
  while (!predicate(page) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    page = manager.read(id, 0, 1_000);
  }
  if (!predicate(page)) throw new Error(`Timed out waiting for watch events: ${JSON.stringify(page)}`);
  return page;
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll();
  await Promise.all(temporaryPaths.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe('WatchManager', () => {
  it('captures changes and pages them with exclusive cursors', async () => {
    const { base, manager } = await setup();
    const session = await manager.start({ path: base, recursive: false });

    await fs.writeFile(path.join(base, 'first.txt'), 'one');
    await fs.writeFile(path.join(base, 'second.txt'), 'two');
    const page = await waitFor(manager, session.id, (current) => {
      const paths = current.events.map((event) => event.path);
      return paths.some((value) => value.endsWith('first.txt')) && paths.some((value) => value.endsWith('second.txt'));
    });

    expect(page.events.every((event) => event.cursor > 0)).toBe(true);
    const firstCursor = page.events[0]!.cursor;
    const next = manager.read(session.id, firstCursor, 1_000);
    expect(next.events.length).toBeGreaterThan(0);
    expect(next.events.every((event) => event.cursor > firstCursor)).toBe(true);
    expect(next.requestedAfter).toBe(firstCursor);
  });

  it('reports cursor truncation after bounded retention', async () => {
    const { base, store, manager } = await setup();
    await store.update({ maxWatchEvents: 2 }, false);
    const session = await manager.start({ path: base, recursive: false });

    for (let index = 0; index < 4; index += 1) {
      await fs.writeFile(path.join(base, `${index}.txt`), String(index));
    }
    const page = await waitFor(manager, session.id, (current) => current.latestCursor >= 3);

    expect(page.events.length).toBeLessThanOrEqual(2);
    expect(page.truncatedBeforeCursor).toBe(true);
    expect(page.firstAvailableCursor).toBeGreaterThan(1);
  });

  it('closes a stopped watcher and retains its final events', async () => {
    const { base, manager } = await setup();
    const session = await manager.start({ path: base, recursive: false });
    await fs.writeFile(path.join(base, 'before-stop.txt'), 'one');
    await waitFor(manager, session.id, (current) => current.events.length > 0);

    const stopped = manager.stop(session.id);
    const cursorAtStop = manager.read(session.id, 0, 1_000).latestCursor;
    await fs.writeFile(path.join(base, 'after-stop.txt'), 'two');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(stopped.status).toBe('stopped');
    expect(manager.read(session.id, 0, 1_000).latestCursor).toBe(cursorAtStop);
  });

  it('enforces safe-profile allowed roots before watching', async () => {
    const { base, store, manager } = await setup('safe');
    const allowed = path.join(base, 'allowed');
    const denied = await makeTempDir();
    await fs.mkdir(allowed, { recursive: true });
    await store.update({ allowedRoots: [allowed] }, false);

    await expect(manager.start({ path: denied, recursive: false })).rejects.toBeInstanceOf(PolicyError);
  });

  it('rejects recursive watching for a file', async () => {
    const { base, manager } = await setup();
    const file = path.join(base, 'single.txt');
    await fs.writeFile(file, 'content');

    await expect(manager.start({ path: file, recursive: true })).rejects.toThrow('Recursive watch requires a directory.');
  });
});
