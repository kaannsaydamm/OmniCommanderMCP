import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], cwd?: string, maxBuffer = 32 * 1024 * 1024) {
  const { stdout, stderr } = await execFileAsync(command, args, { cwd, windowsHide: true, maxBuffer });
  return { command, args, cwd, stdout, stderr };
}

async function gitRoot(context: ToolContext, cwd: string): Promise<string> {
  const directory = await context.policy.assertPath(cwd, 'git working directory');
  const result = await run('git', ['rev-parse', '--show-toplevel'], directory);
  return context.policy.assertPath(result.stdout.trim(), 'git root');
}

function archiveType(target: string): 'zip' | 'tar' | 'tar.gz' | '7z' {
  const lower = target.toLowerCase();
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.7z')) return '7z';
  return 'zip';
}

async function hasCommand(command: string): Promise<boolean> {
  try { await run(process.platform === 'win32' ? 'where.exe' : 'which', [command]); return true; } catch { return false; }
}

export function registerDeveloperTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'git_status', {
    title: 'Git Status', description: 'Return repository root, branch, porcelain status and remotes.',
    inputSchema: { cwd: z.string().default('.') }, annotations: { readOnlyHint: true }
  }, async ({ cwd }) => {
    const root = await gitRoot(context, cwd);
    const [status, branch, remotes] = await Promise.all([
      run('git', ['status', '--porcelain=v2', '--branch'], root),
      run('git', ['branch', '--show-current'], root),
      run('git', ['remote', '-v'], root)
    ]);
    return { root, branch: branch.stdout.trim(), status: status.stdout, remotes: remotes.stdout };
  });

  context.register(server, 'git_diff', {
    title: 'Git Diff', description: 'Return a working-tree, staged, commit or range diff.',
    inputSchema: { cwd: z.string().default('.'), staged: z.boolean().default(false), base: z.string().optional(), head: z.string().optional(), paths: z.array(z.string()).max(200).default([]), stat: z.boolean().default(false) },
    annotations: { readOnlyHint: true }
  }, async ({ cwd, staged, base, head, paths, stat }) => {
    const root = await gitRoot(context, cwd);
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (stat) args.push('--stat');
    if (base && head) args.push(`${base}..${head}`); else if (base) args.push(base);
    if (paths.length) args.push('--', ...paths);
    return run('git', args, root, context.config.get().maxOutputBytes);
  });

  context.register(server, 'git_log', {
    title: 'Git Log', description: 'Return recent commits as structured JSON lines.',
    inputSchema: { cwd: z.string().default('.'), limit: z.number().int().min(1).max(1_000).default(50), ref: z.string().optional(), path: z.string().optional() },
    annotations: { readOnlyHint: true }
  }, async ({ cwd, limit, ref, path: filePath }) => {
    const root = await gitRoot(context, cwd);
    const format = '%H%x09%P%x09%an%x09%ae%x09%aI%x09%s';
    const args = ['log', `-${limit}`, `--pretty=format:${format}`];
    if (ref) args.push(ref);
    if (filePath) args.push('--', filePath);
    const output = await run('git', args, root);
    return { root, commits: output.stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [hash, parents, author, email, date, ...subject] = line.split('\t'); return { hash, parents: parents?.split(' ').filter(Boolean), author, email, date, subject: subject.join('\t') }; }) };
  });

  context.register(server, 'git_stage', {
    title: 'Git Stage', description: 'Stage selected paths or all changes.',
    inputSchema: { cwd: z.string().default('.'), paths: z.array(z.string()).max(1_000).default([]), all: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ cwd, paths, all }) => {
    const root = await gitRoot(context, cwd);
    return run('git', all ? ['add', '-A'] : ['add', '--', ...paths], root);
  });

  context.register(server, 'git_commit', {
    title: 'Git Commit', description: 'Create a commit from staged changes.',
    inputSchema: { cwd: z.string().default('.'), message: z.string().min(1), amend: z.boolean().default(false), noVerify: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ cwd, message, amend, noVerify }) => {
    const root = await gitRoot(context, cwd);
    const args = ['commit', '-m', message];
    if (amend) args.push('--amend');
    if (noVerify) args.push('--no-verify');
    return run('git', args, root, context.config.get().maxOutputBytes);
  });

  context.register(server, 'git_branch', {
    title: 'Manage Git Branch', description: 'List, create, delete or rename branches.',
    inputSchema: { cwd: z.string().default('.'), action: z.enum(['list', 'create', 'delete', 'rename']), name: z.string().optional(), newName: z.string().optional(), force: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ cwd, action, name, newName, force }) => {
    const root = await gitRoot(context, cwd);
    if (action === 'list') return run('git', ['branch', '-vv', '--all'], root);
    if (!name) throw new Error('name is required.');
    if (action === 'create') return run('git', ['branch', name], root);
    if (action === 'delete') return run('git', ['branch', force ? '-D' : '-d', name], root);
    if (!newName) throw new Error('newName is required for rename.');
    return run('git', ['branch', '-m', name, newName], root);
  });

  context.register(server, 'git_checkout', {
    title: 'Git Checkout/Switch', description: 'Switch branches or restore a path.',
    inputSchema: { cwd: z.string().default('.'), ref: z.string().min(1), create: z.boolean().default(false), paths: z.array(z.string()).max(500).default([]) },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ cwd, ref, create, paths }) => {
    const root = await gitRoot(context, cwd);
    if (paths.length) return run('git', ['checkout', ref, '--', ...paths], root);
    return run('git', ['switch', ...(create ? ['-c'] : []), ref], root);
  });

  context.register(server, 'git_remote_sync', {
    title: 'Git Fetch/Pull/Push', description: 'Fetch, pull or push a repository using existing Git credentials.',
    inputSchema: { cwd: z.string().default('.'), action: z.enum(['fetch', 'pull', 'push']), remote: z.string().default('origin'), refspec: z.string().optional(), rebase: z.boolean().default(false), forceWithLease: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ cwd, action, remote, refspec, rebase, forceWithLease }) => {
    const root = await gitRoot(context, cwd);
    const args = [action];
    if (action === 'pull' && rebase) args.push('--rebase');
    if (action === 'push' && forceWithLease) args.push('--force-with-lease');
    args.push(remote);
    if (refspec) args.push(refspec);
    return run('git', args, root, context.config.get().maxOutputBytes);
  });

  context.register(server, 'git_clone', {
    title: 'Git Clone', description: 'Clone a Git repository to an allowed destination.',
    inputSchema: { repository: z.string().min(1), destination: z.string().min(1), branch: z.string().optional(), depth: z.number().int().positive().optional(), recurseSubmodules: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ repository, destination, branch, depth, recurseSubmodules }) => {
    if (/^https?:\/\//i.test(repository)) await context.policy.assertUrl(repository);
    const target = await context.policy.assertPath(destination, 'git clone destination');
    const args = ['clone'];
    if (branch) args.push('--branch', branch);
    if (depth) args.push('--depth', String(depth));
    if (recurseSubmodules) args.push('--recurse-submodules');
    args.push(repository, target);
    return run('git', args, path.dirname(target), context.config.get().maxOutputBytes);
  });

  context.register(server, 'archive_list', {
    title: 'List Archive', description: 'List files in ZIP, TAR, TAR.GZ/TGZ or 7z archives.',
    inputSchema: { path: z.string().min(1) }, annotations: { readOnlyHint: true }
  }, async ({ path: inputPath }) => {
    const target = await context.policy.assertPath(inputPath, 'archive list');
    const type = archiveType(target);
    if (type === 'zip' && process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::OpenRead('${target.replace(/'/g, "''")}').Entries | Select FullName,Length,CompressedLength | ConvertTo-Json -Compress`]);
    if (type === '7z') return run('7z', ['l', '-slt', target]);
    return run('tar', ['-tf', target]);
  });

  context.register(server, 'archive_create', {
    title: 'Create Archive', description: 'Create ZIP, TAR, TAR.GZ/TGZ or 7z archive from selected source paths.',
    inputSchema: { output: z.string().min(1), sources: z.array(z.string().min(1)).min(1).max(1_000), overwrite: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ output, sources, overwrite }) => {
    const target = await context.policy.assertPath(output, 'archive output');
    const resolvedSources = await Promise.all(sources.map((source: string) => context.policy.assertPath(source, 'archive source')));
    if (!overwrite) await fs.access(target).then(() => { throw new Error(`Archive already exists: ${target}`); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    else await fs.rm(target, { force: true });
    await fs.mkdir(path.dirname(target), { recursive: true });
    const type = archiveType(target);
    if (type === 'zip' && process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path @(${resolvedSources.map((source) => `'${source.replace(/'/g, "''")}'`).join(',')}) -DestinationPath '${target.replace(/'/g, "''")}' -Force`]);
    if (type === '7z') {
      if (!await hasCommand('7z')) throw new Error('7z executable is required for .7z archives.');
      return run('7z', ['a', target, ...resolvedSources]);
    }
    const flag = type === 'tar.gz' ? '-czf' : '-cf';
    return run('tar', [flag, target, ...resolvedSources]);
  });

  context.register(server, 'archive_extract', {
    title: 'Extract Archive', description: 'Extract ZIP, TAR, TAR.GZ/TGZ or 7z archive into a destination directory.',
    inputSchema: { archive: z.string().min(1), destination: z.string().min(1), overwrite: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ archive, destination, overwrite }) => {
    const source = await context.policy.assertPath(archive, 'archive source');
    const target = await context.policy.assertPath(destination, 'archive destination');
    await fs.mkdir(target, { recursive: true });
    const type = archiveType(source);
    if (type === 'zip' && process.platform === 'win32') return run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -Path '${source.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}'${overwrite ? ' -Force' : ''}`]);
    if (type === 'zip' && await hasCommand('unzip')) return run('unzip', [...(overwrite ? ['-o'] : ['-n']), source, '-d', target]);
    if (type === '7z') return run('7z', ['x', source, `-o${target}`, overwrite ? '-aoa' : '-aos']);
    return run('tar', ['-xf', source, '-C', target, ...(overwrite ? ['--overwrite'] : ['--keep-old-files'])]);
  });
}
