# File Watch Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add policy-bound native filesystem watch sessions with bounded event retention, cursor pagination, explicit shutdown, and MCP tools.

**Architecture:** A focused `WatchManager` owns native `FSWatcher` instances and bounded event buffers. `ToolContext` exposes that manager to four filesystem tools, while stdio and HTTP runtimes include it in their existing periodic cleanup lifecycle.

**Tech Stack:** Node.js 20+ `node:fs`, TypeScript 5, Zod 3, MCP SDK 1.29, Vitest 3.

## Global Constraints

- Preserve the existing `safe` and `full` path policy semantics.
- Never retain more than the configured event limit per session.
- Event cursors are monotonically increasing and reads use an exclusive `after` cursor.
- Native watcher failures are surfaced as session errors; they are not silently swallowed.
- All watcher handles are closed by explicit stop, cleanup, MCP server close, or process shutdown.
- No additional runtime dependency is introduced.

---

### Task 1: Define configuration limits

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Test: `tests/config-policy.test.ts`

**Interfaces:**
- Produces: `OmniConfig.maxWatchEvents: number`
- Produces: safe default `10_000`, full default `100_000`

- [ ] **Step 1: Write the failing configuration test**

```ts
it('uses bounded profile-specific watch event limits', async () => {
  const base = await makeTempDir();
  const safe = await loadConfig([`--config=${path.join(base, 'safe.json')}`, '--safe']);
  const full = await loadConfig([`--config=${path.join(base, 'full.json')}`, '--full']);

  expect(safe.maxWatchEvents).toBe(10_000);
  expect(full.maxWatchEvents).toBe(100_000);
});
```

- [ ] **Step 2: Run the test and verify the missing-property failure**

Run: `npm test -- tests/config-policy.test.ts`

Expected: FAIL because `maxWatchEvents` is not defined.

- [ ] **Step 3: Add the configuration property and profile defaults**

```ts
export interface OmniConfig {
  maxWatchEvents: number;
}

// safeDefaults
maxWatchEvents: 10_000,

// fullDefaults
maxWatchEvents: 100_000,
```

- [ ] **Step 4: Run the configuration test**

Run: `npm test -- tests/config-policy.test.ts`

Expected: PASS.

### Task 2: Implement bounded native watch sessions

**Files:**
- Create: `src/managers/watch-manager.ts`
- Create: `tests/watch-manager.test.ts`

**Interfaces:**
- Consumes: `ConfigStore`, `PolicyEngine`
- Produces: `WatchManager.start(input): Promise<WatchSessionDescription>`
- Produces: `WatchManager.read(id, after, limit): WatchEventPage`
- Produces: `WatchManager.stop(id): WatchSessionDescription`
- Produces: `WatchManager.list(): WatchSessionDescription[]`
- Produces: `WatchManager.cleanup(maxAgeMs?): number`
- Produces: `WatchManager.closeAll(): void`

- [ ] **Step 1: Write the failing lifecycle and pagination tests**

```ts
it('captures changes and pages them with exclusive cursors', async () => {
  const { base, store, policy } = await setup();
  const manager = new WatchManager(store, policy);
  const session = await manager.start({ path: base, recursive: false });

  await fs.writeFile(path.join(base, 'first.txt'), 'one');
  await fs.writeFile(path.join(base, 'second.txt'), 'two');
  const page = await waitForEvents(manager, session.id, 2);

  expect(page.events.length).toBeGreaterThanOrEqual(2);
  expect(page.events.every((event) => event.cursor > 0)).toBe(true);
  const next = manager.read(session.id, page.events[0]!.cursor, 100);
  expect(next.events.every((event) => event.cursor > page.events[0]!.cursor)).toBe(true);
  manager.closeAll();
});

it('reports pagination truncation after bounded retention', async () => {
  const { base, store, policy } = await setup();
  await store.update({ maxWatchEvents: 2 }, false);
  const manager = new WatchManager(store, policy);
  const session = await manager.start({ path: base, recursive: false });

  for (let index = 0; index < 4; index += 1) {
    await fs.writeFile(path.join(base, `${index}.txt`), String(index));
  }
  const page = await waitForEvents(manager, session.id, 2);
  expect(page.events.length).toBeLessThanOrEqual(2);
  expect(page.truncatedBeforeCursor).toBe(true);
  manager.closeAll();
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npm test -- tests/watch-manager.test.ts`

Expected: FAIL because `WatchManager` does not exist.

- [ ] **Step 3: Implement `WatchManager` with a bounded event buffer**

```ts
export interface WatchEvent {
  cursor: number;
  eventType: 'rename' | 'change' | 'error';
  path: string;
  observedAt: string;
  error?: string;
}

export class WatchManager {
  private readonly sessions = new Map<string, WatchSession>();

  async start(input: StartWatchOptions): Promise<WatchSessionDescription> {
    const root = await this.policy.assertPath(input.path, 'watch');
    const stat = await fs.stat(root);
    if (!stat.isDirectory() && input.recursive) {
      throw new Error('Recursive watch requires a directory.');
    }
    const id = randomUUID();
    const session = createSession(id, root, input.recursive ?? false);
    session.watcher = watch(root, { recursive: session.recursive }, (eventType, filename) => {
      const candidate = filename ? path.resolve(root, filename.toString()) : root;
      const relative = path.relative(root, candidate);
      const eventPath = relative.startsWith('..') || path.isAbsolute(relative) ? root : candidate;
      this.append(session, { eventType, path: eventPath });
    });
    session.watcher.on('error', (error) => {
      this.append(session, { eventType: 'error', path: root, error: error.message });
      session.status = 'error';
      session.endedAt = Date.now();
    });
    this.sessions.set(id, session);
    return this.describe(session);
  }

  read(id: string, after = 0, limit = 100): WatchEventPage {
    const session = this.require(id);
    const boundedLimit = Math.max(1, Math.min(limit, 1_000));
    const firstCursor = session.events[0]?.cursor ?? session.nextCursor;
    const events = session.events.filter((event) => event.cursor > after).slice(0, boundedLimit);
    return {
      id,
      events,
      requestedAfter: after,
      nextCursor: events.at(-1)?.cursor ?? after,
      truncatedBeforeCursor: after < firstCursor - 1,
      hasMore: session.events.some((event) => event.cursor > (events.at(-1)?.cursor ?? after))
    };
  }
}
```

- [ ] **Step 4: Run watch-manager tests**

Run: `npm test -- tests/watch-manager.test.ts`

Expected: PASS with watcher handles closed during test teardown.

### Task 3: Expose watcher tools through MCP

**Files:**
- Modify: `src/tools/types.ts`
- Modify: `src/server.ts`
- Modify: `src/http.ts`
- Modify: `src/tools/filesystem.ts`
- Modify: `tests/tool-surface.test.ts`

**Interfaces:**
- Consumes: `WatchManager`
- Produces tools: `fs_watch_start`, `fs_watch_events`, `fs_watch_stop`, `fs_watch_sessions`

- [ ] **Step 1: Add failing tool discovery assertions**

```ts
expect(names).toEqual(expect.arrayContaining([
  'fs_watch_start',
  'fs_watch_events',
  'fs_watch_stop',
  'fs_watch_sessions'
]));
```

- [ ] **Step 2: Run the discovery test and verify failure**

Run: `npm test -- tests/tool-surface.test.ts`

Expected: FAIL because the four tools are absent.

- [ ] **Step 3: Wire the manager into runtime context and cleanup**

```ts
const watches = new WatchManager(config, policy);
const context = createToolContext(config, policy, audit, sessions, search, watches);

const cleanup = (): void => {
  sessions.cleanup();
  watches.cleanup();
};
```

- [ ] **Step 4: Register four validated MCP tools**

```ts
context.register(server, 'fs_watch_start', {
  title: 'Start File Watch',
  description: 'Start a bounded native file watch session.',
  inputSchema: {
    path: z.string().min(1),
    recursive: z.boolean().default(false)
  },
  annotations: { readOnlyHint: true }
}, (input) => context.watches.start(input));

context.register(server, 'fs_watch_events', {
  title: 'Read File Watch Events',
  description: 'Read a cursor-paginated page from a file watch session.',
  inputSchema: {
    id: z.string().uuid(),
    after: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(1_000).default(100)
  },
  annotations: { readOnlyHint: true }
}, ({ id, after, limit }) => context.watches.read(id, after, limit));

context.register(server, 'fs_watch_stop', {
  title: 'Stop File Watch',
  description: 'Close a native file watcher and retain its final buffered events.',
  inputSchema: { id: z.string().uuid() },
  annotations: { readOnlyHint: false }
}, ({ id }) => context.watches.stop(id));

context.register(server, 'fs_watch_sessions', {
  title: 'List File Watch Sessions',
  description: 'List active and recently stopped file watch sessions.',
  inputSchema: {},
  annotations: { readOnlyHint: true }
}, () => ({ sessions: context.watches.list() }));
```

- [ ] **Step 5: Run tool discovery and all watcher tests**

Run: `npm test -- tests/tool-surface.test.ts tests/watch-manager.test.ts`

Expected: PASS.

### Task 4: Document and release the feature

**Files:**
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Produces: documented tool contracts while the package remains on `0.2.0` until every 0.3 roadmap item is complete

- [ ] **Step 1: Update the tool catalog and lifecycle documentation**

Document exclusive cursor semantics, bounded retention, truncation reporting, native platform caveats, and explicit `fs_watch_stop` cleanup.

- [ ] **Step 2: Mark only the file-watch roadmap item implemented**

Move the file-watch bullet into the implemented section without changing the status of browser, document, platform, or packaging work.

- [ ] **Step 3: Run full verification**

Run: `npm run typecheck && npm test && npm run build`

Expected: typecheck exit 0, all tests pass, build exit 0.

- [ ] **Step 4: Commit and push**

```bash
git add src tests README.md docs
git commit -m "feat: add paginated file watch sessions"
git push origin main
```
