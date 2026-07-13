import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';
import { withTimeout } from '../utils/async.js';

const execFileAsync = promisify(execFile);

async function listSystemProcesses(maxOutputBytes: number): Promise<unknown[]> {
  if (process.platform === 'win32') {
    const script = [
      '$p = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath,CreationDate',
      '$p | ConvertTo-Json -Depth 3 -Compress'
    ].join('; ');
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], { maxBuffer: maxOutputBytes, windowsHide: true });
    const parsed = JSON.parse(stdout || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const args = process.platform === 'darwin'
    ? ['-axo', 'pid=,ppid=,user=,comm=,args=']
    : ['-eo', 'pid=,ppid=,user=,comm=,args=', '--no-headers'];
  const { stdout } = await execFileAsync('ps', args, { maxBuffer: maxOutputBytes });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!match) return { raw: line };
    return { pid: Number(match[1]), ppid: Number(match[2]), user: match[3], command: match[4], args: match[5] };
  });
}

export function registerProcessTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'shell_exec', {
    title: 'Execute Command',
    description: 'Execute a shell command and wait for completion. Use process_start for interactive or long-running commands.',
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().optional(),
      shell: z.string().optional(),
      env: z.record(z.string()).optional(),
      timeoutMs: z.number().int().min(0).optional(),
      maxOutputBytes: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ command, cwd, shell, env, timeoutMs, maxOutputBytes }) => {
    context.policy.assertCommand(command);
    const workingDirectory = cwd ? await context.policy.assertPath(cwd, 'command cwd') : process.cwd();
    const config = context.config.get();
    const cap = Math.min(maxOutputBytes ?? config.maxOutputBytes, config.maxOutputBytes);
    const session = await context.sessions.start({ command, cwd: workingDirectory, shell, env, timeoutMs: 0 });
    const id = String(session.id);
    const deadline = timeoutMs ?? config.processTimeoutMs;
    const wait = async (): Promise<Record<string, unknown>> => {
      while (true) {
        const current = context.sessions.read(id, 0, cap);
        if (current.status !== 'running') return current;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };
    try {
      return await withTimeout(wait(), deadline, 'command');
    } catch (error) {
      await context.sessions.terminate(id, true).catch(() => undefined);
      throw error;
    }
  });

  context.register(server, 'process_start', {
    title: 'Start Process Session',
    description: 'Start a command in a persistent process session. Output is buffered and stdin remains writable.',
    inputSchema: {
      command: z.string().min(1),
      cwd: z.string().optional(),
      shell: z.string().optional(),
      env: z.record(z.string()).optional(),
      autoTerminateAfterMs: z.number().int().min(0).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ command, cwd, shell, env, autoTerminateAfterMs }) => context.sessions.start({ command, cwd, shell, env, timeoutMs: autoTerminateAfterMs }));

  context.register(server, 'process_output', {
    title: 'Read Process Output',
    description: 'Read buffered output from a process session using absolute character offsets.',
    inputSchema: {
      sessionId: z.string().uuid(),
      offset: z.number().int().min(0).optional(),
      length: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ sessionId, offset, length }) => context.sessions.read(sessionId, offset, length));

  context.register(server, 'process_input', {
    title: 'Write Process Input',
    description: 'Write to stdin of a running process session.',
    inputSchema: {
      sessionId: z.string().uuid(),
      input: z.string(),
      appendNewline: z.boolean().default(true)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ sessionId, input, appendNewline }) => context.sessions.write(sessionId, input, appendNewline));

  context.register(server, 'process_terminate', {
    title: 'Terminate Process Session',
    description: 'Terminate a managed process session and its child tree where supported.',
    inputSchema: { sessionId: z.string().uuid(), force: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ sessionId, force }) => context.sessions.terminate(sessionId, force));

  context.register(server, 'process_sessions', {
    title: 'List Process Sessions',
    description: 'List all managed process sessions.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => ({ sessions: context.sessions.list() }));

  context.register(server, 'process_list', {
    title: 'List System Processes',
    description: 'List operating-system processes with PID, parent PID, command and arguments where available.',
    inputSchema: { query: z.string().optional(), limit: z.number().int().positive().max(10_000).default(1_000) },
    annotations: { readOnlyHint: true }
  }, async ({ query, limit }) => {
    const processes = await listSystemProcesses(context.config.get().maxOutputBytes);
    const filtered = query
      ? processes.filter((item) => JSON.stringify(item).toLowerCase().includes(query.toLowerCase()))
      : processes;
    return { processes: filtered.slice(0, limit), count: Math.min(filtered.length, limit), totalMatched: filtered.length, truncated: filtered.length > limit };
  });

  context.register(server, 'process_kill', {
    title: 'Kill System Process',
    description: 'Send a termination signal to an operating-system process by PID.',
    inputSchema: {
      pid: z.number().int().positive(),
      signal: z.enum(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP']).default('SIGTERM'),
      tree: z.boolean().default(false)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ pid, signal, tree }) => {
    if (pid === process.pid) throw new Error('Refusing to kill the MCP server process itself.');
    if (process.platform === 'win32' && tree) {
      const args = ['/pid', String(pid), '/t'];
      if (signal === 'SIGKILL') args.push('/f');
      await execFileAsync('taskkill', args, { windowsHide: true });
    } else {
      process.kill(pid, signal);
    }
    return { pid, signal, tree, sent: true };
  });
}
