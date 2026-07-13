import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import type { ConfigStore } from '../config.js';
import type { PolicyEngine } from '../policy.js';

export interface StartProcessOptions {
  command: string;
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface Session {
  id: string;
  child: ChildProcessWithoutNullStreams;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  status: 'running' | 'exited' | 'terminated';
  buffer: string;
  baseOffset: number;
  timeout?: NodeJS.Timeout;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return process.env.SHELL || '/bin/sh';
}

function shellArgs(shell: string, command: string): string[] {
  const base = shell.toLowerCase();
  if (process.platform === 'win32') {
    if (base.endsWith('powershell.exe') || base.endsWith('pwsh.exe') || base === 'powershell' || base === 'pwsh') {
      return ['-NoLogo', '-NoProfile', '-Command', command];
    }
    return ['/d', '/s', '/c', `"${command}"`];
  }
  return ['-lc', command];
}

function appendWithCap(session: Session, chunk: string, capBytes: number): void {
  session.buffer += chunk;
  const currentBytes = Buffer.byteLength(session.buffer, 'utf8');
  if (currentBytes <= capBytes) return;

  const excess = currentBytes - capBytes;
  let removeChars = Math.min(session.buffer.length, Math.ceil(excess * 1.2));
  while (removeChars < session.buffer.length && Buffer.byteLength(session.buffer.slice(removeChars), 'utf8') > capBytes) {
    removeChars += Math.ceil((session.buffer.length - removeChars) / 8);
  }
  session.buffer = session.buffer.slice(removeChars);
  session.baseOffset += removeChars;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly policy: PolicyEngine
  ) {}

  async start(options: StartProcessOptions): Promise<Record<string, unknown>> {
    this.policy.assertCommand(options.command);
    const cwd = options.cwd ? await this.policy.assertPath(options.cwd, 'process cwd') : process.cwd();
    const shell = options.shell || defaultShell();
    const id = crypto.randomUUID();
    const child = spawn(shell, shellArgs(shell, options.command), {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32'
    });

    const session: Session = {
      id,
      child,
      command: options.command,
      cwd,
      startedAt: Date.now(),
      status: 'running',
      buffer: '',
      baseOffset: 0
    };
    this.sessions.set(id, session);

    const cap = this.configStore.get().sessionBufferBytes;
    child.stdout.on('data', (data: Buffer) => appendWithCap(session, data.toString('utf8'), cap));
    child.stderr.on('data', (data: Buffer) => appendWithCap(session, `[stderr] ${data.toString('utf8')}`, cap));
    child.on('error', (error) => appendWithCap(session, `[process-error] ${error.message}\n`, cap));
    child.on('exit', (code, signal) => {
      session.status = session.status === 'terminated' ? 'terminated' : 'exited';
      session.exitCode = code;
      session.signal = signal;
      session.endedAt = Date.now();
      if (session.timeout) clearTimeout(session.timeout);
    });

    const timeoutMs = options.timeoutMs ?? 0;
    if (timeoutMs > 0) {
      session.timeout = setTimeout(() => {
        void this.terminate(id, true).catch(() => undefined);
      }, timeoutMs);
      session.timeout.unref?.();
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
    return this.describe(session);
  }

  read(id: string, offset?: number, length?: number): Record<string, unknown> {
    const session = this.require(id);
    const requestedOffset = offset ?? session.baseOffset;
    const effectiveOffset = Math.max(requestedOffset, session.baseOffset);
    const localStart = effectiveOffset - session.baseOffset;
    const maxLength = Math.max(1, Math.min(length ?? this.configStore.get().maxOutputBytes, this.configStore.get().maxOutputBytes));
    const output = session.buffer.slice(localStart, localStart + maxLength);
    return {
      ...this.describe(session),
      output,
      requestedOffset,
      effectiveOffset,
      nextOffset: effectiveOffset + output.length,
      baseOffset: session.baseOffset,
      bufferLength: session.buffer.length,
      truncatedBeforeOffset: requestedOffset < session.baseOffset,
      hasMore: localStart + output.length < session.buffer.length
    };
  }

  write(id: string, input: string, appendNewline = false): Record<string, unknown> {
    const session = this.require(id);
    if (session.status !== 'running') throw new Error(`Session ${id} is not running.`);
    session.child.stdin.write(appendNewline ? `${input}${os.EOL}` : input);
    return { id, pid: session.child.pid, bytesWritten: Buffer.byteLength(input, 'utf8') + (appendNewline ? Buffer.byteLength(os.EOL) : 0) };
  }

  async terminate(id: string, force = false): Promise<Record<string, unknown>> {
    const session = this.require(id);
    if (session.status !== 'running') return this.describe(session);
    session.status = 'terminated';

    if (process.platform === 'win32' && session.child.pid) {
      const args = ['/pid', String(session.child.pid), '/t'];
      if (force) args.push('/f');
      spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } else {
      session.child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }

    if (!force) {
      const timer = setTimeout(() => {
        if (session.status === 'running' || session.child.exitCode === null) {
          try {
            session.child.kill('SIGKILL');
          } catch {
            // Process may have already exited.
          }
        }
      }, 2_000);
      timer.unref?.();
    }

    return this.describe(session);
  }

  list(): Record<string, unknown>[] {
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

  private require(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown process session: ${id}`);
    return session;
  }

  private describe(session: Session): Record<string, unknown> {
    return {
      id: session.id,
      pid: session.child.pid,
      command: session.command,
      cwd: session.cwd,
      status: session.status,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : undefined,
      runtimeMs: (session.endedAt ?? Date.now()) - session.startedAt,
      exitCode: session.exitCode,
      signal: session.signal
    };
  }
}
