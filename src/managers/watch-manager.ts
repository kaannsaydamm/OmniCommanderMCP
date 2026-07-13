import { randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type { ConfigStore } from '../config.js';
import type { PolicyEngine } from '../policy.js';

export interface StartWatchOptions {
  path: string;
  recursive?: boolean;
}

export interface WatchEvent {
  cursor: number;
  eventType: 'rename' | 'change' | 'error';
  path: string;
  observedAt: string;
  error?: string;
}

export interface WatchEventPage {
  id: string;
  events: WatchEvent[];
  requestedAfter: number;
  firstAvailableCursor: number;
  latestCursor: number;
  nextCursor: number;
  truncatedBeforeCursor: boolean;
  hasMore: boolean;
}

export interface WatchSessionDescription {
  id: string;
  path: string;
  recursive: boolean;
  status: 'running' | 'stopped' | 'error';
  startedAt: string;
  endedAt?: string;
  latestCursor: number;
  bufferedEvents: number;
  error?: string;
}

interface WatchSession {
  id: string;
  root: string;
  recursive: boolean;
  isDirectory: boolean;
  watcher: FSWatcher;
  status: WatchSessionDescription['status'];
  startedAt: number;
  endedAt?: number;
  nextCursor: number;
  events: WatchEvent[];
  error?: string;
}

interface PendingEvent {
  eventType: WatchEvent['eventType'];
  path: string;
  error?: string;
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Owns native filesystem watcher handles and their bounded event buffers. */
export class WatchManager {
  private readonly sessions = new Map<string, WatchSession>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly policy: PolicyEngine
  ) {}

  async start(input: StartWatchOptions): Promise<WatchSessionDescription> {
    const root = await this.policy.assertPath(input.path, 'watch');
    const stat = await fs.stat(root);
    const recursive = input.recursive ?? false;
    if (!stat.isDirectory() && recursive) throw new Error('Recursive watch requires a directory.');

    const id = randomUUID();
    const startedAt = Date.now();
    let session: WatchSession;
    const watcher = watch(root, { recursive }, (eventType, filename) => {
      if (!session || session.status !== 'running') return;
      let eventPath = root;
      if (session.isDirectory && filename) {
        const candidate = path.resolve(root, filename.toString());
        if (pathWithin(candidate, root)) eventPath = candidate;
      }
      this.append(session, { eventType, path: eventPath });
    });

    session = {
      id,
      root,
      recursive,
      isDirectory: stat.isDirectory(),
      watcher,
      status: 'running',
      startedAt,
      nextCursor: 0,
      events: []
    };
    this.sessions.set(id, session);

    watcher.on('error', (error) => {
      if (session.status !== 'running') return;
      this.append(session, { eventType: 'error', path: root, error: error.message });
      session.status = 'error';
      session.error = error.message;
      session.endedAt = Date.now();
      try {
        watcher.close();
      } catch (closeError) {
        const message = closeError instanceof Error ? closeError.message : String(closeError);
        session.error = `${session.error}; watcher close failed: ${message}`;
      }
    });
    watcher.on('close', () => {
      if (session.status === 'running') session.status = 'stopped';
      session.endedAt ??= Date.now();
    });

    return this.describe(session);
  }

  read(id: string, after = 0, limit = 100): WatchEventPage {
    const session = this.require(id);
    const requestedAfter = Math.max(0, Math.trunc(after));
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    const firstAvailableCursor = session.events[0]?.cursor ?? session.nextCursor + 1;
    const available = session.events.filter((event) => event.cursor > requestedAfter);
    const events = available.slice(0, boundedLimit);
    const nextCursor = events.at(-1)?.cursor ?? requestedAfter;

    return {
      id,
      events,
      requestedAfter,
      firstAvailableCursor,
      latestCursor: session.nextCursor,
      nextCursor,
      truncatedBeforeCursor: firstAvailableCursor > 1 && requestedAfter < firstAvailableCursor - 1,
      hasMore: available.length > events.length
    };
  }

  stop(id: string): WatchSessionDescription {
    const session = this.require(id);
    if (session.status === 'running') {
      session.status = 'stopped';
      session.endedAt = Date.now();
      session.watcher.close();
    }
    return this.describe(session);
  }

  list(): WatchSessionDescription[] {
    return [...this.sessions.values()].map((session) => this.describe(session));
  }

  cleanup(maxAgeMs = 30 * 60_000): number {
    const threshold = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (session.status !== 'running' && (session.endedAt ?? session.startedAt) < threshold) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      if (session.status === 'running') this.stop(session.id);
    }
    this.sessions.clear();
  }

  private append(session: WatchSession, input: PendingEvent): void {
    const event: WatchEvent = {
      cursor: ++session.nextCursor,
      eventType: input.eventType,
      path: input.path,
      observedAt: new Date().toISOString()
    };
    if (input.error) event.error = input.error;
    session.events.push(event);

    const configuredLimit = this.configStore.get().maxWatchEvents;
    const cap = Number.isFinite(configuredLimit) ? Math.max(1, Math.trunc(configuredLimit)) : 1;
    if (session.events.length > cap) session.events.splice(0, session.events.length - cap);
  }

  private require(id: string): WatchSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown file watch session: ${id}`);
    return session;
  }

  private describe(session: WatchSession): WatchSessionDescription {
    const result: WatchSessionDescription = {
      id: session.id,
      path: session.root,
      recursive: session.recursive,
      status: session.status,
      startedAt: new Date(session.startedAt).toISOString(),
      latestCursor: session.nextCursor,
      bufferedEvents: session.events.length
    };
    if (session.endedAt) result.endedAt = new Date(session.endedAt).toISOString();
    if (session.error) result.error = session.error;
    return result;
  }
}
