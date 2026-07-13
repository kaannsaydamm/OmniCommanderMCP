import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';

const textEncoding = z.enum(['utf8', 'base64', 'hex']).default('utf8');

function encodeBuffer(buffer: Buffer, encoding: 'utf8' | 'base64' | 'hex'): string {
  return buffer.toString(encoding);
}

function decodeContent(content: string, encoding: 'utf8' | 'base64' | 'hex'): Buffer {
  return Buffer.from(content, encoding);
}

async function listTree(root: string, depth: number, maxEntries: number, includeHidden: boolean): Promise<Record<string, unknown>[]> {
  const output: Record<string, unknown>[] = [];

  const walk = async (directory: string, currentDepth: number): Promise<void> => {
    if (output.length >= maxEntries) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      output.push({ path: directory, type: 'error', error: error instanceof Error ? error.message : String(error) });
      return;
    }

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (output.length >= maxEntries) return;
      if (!includeHidden && entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      let stat;
      try {
        stat = await fs.lstat(absolute);
      } catch (error) {
        output.push({ path: absolute, type: 'error', error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      output.push({
        path: absolute,
        relativePath: path.relative(root, absolute),
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
      if (entry.isDirectory() && currentDepth < depth) await walk(absolute, currentDepth + 1);
    }
  };

  await walk(root, 1);
  return output;
}

export function registerFilesystemTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'fs_read', {
    title: 'Read File',
    description: 'Read a file as UTF-8, base64 or hex. Supports byte-range and line-range pagination.',
    inputSchema: {
      path: z.string().min(1),
      encoding: textEncoding,
      unit: z.enum(['bytes', 'lines']).default('bytes'),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ path: inputPath, encoding, unit, offset, length }) => {
    const filePath = await context.policy.assertPath(inputPath, 'read');
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Not a file: ${filePath}`);
    const config = context.config.get();

    if (unit === 'lines') {
      if (stat.size > config.maxReadBytes) throw new Error(`File is ${stat.size} bytes; line-mode limit is ${config.maxReadBytes}. Use byte mode.`);
      const text = await fs.readFile(filePath, 'utf8');
      const lines = text.split(/\r?\n/);
      const selected = lines.slice(offset, length ? offset + length : undefined);
      return {
        path: filePath,
        unit,
        offset,
        nextOffset: offset + selected.length,
        totalLines: lines.length,
        truncated: offset + selected.length < lines.length,
        content: selected.join('\n')
      };
    }

    const requestedLength = Math.min(length ?? config.maxReadBytes, config.maxReadBytes);
    const handle = await fs.open(filePath, 'r');
    try {
      const available = Math.max(0, stat.size - offset);
      const bytesToRead = Math.min(requestedLength, available);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      const actual = buffer.subarray(0, bytesRead);
      return {
        path: filePath,
        unit,
        encoding,
        offset,
        bytesRead,
        nextOffset: offset + bytesRead,
        totalBytes: stat.size,
        truncated: offset + bytesRead < stat.size,
        content: encodeBuffer(actual, encoding)
      };
    } finally {
      await handle.close();
    }
  });

  context.register(server, 'fs_read_many', {
    title: 'Read Multiple Files',
    description: 'Read several files independently. A failed file does not abort the entire request.',
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(100),
      encoding: textEncoding,
      maxBytesPerFile: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ paths, encoding, maxBytesPerFile }) => {
    const limit = Math.min(maxBytesPerFile ?? context.config.get().maxReadBytes, context.config.get().maxReadBytes);
    const files = await Promise.all((paths as string[]).map(async (inputPath: string) => {
      try {
        const filePath = await context.policy.assertPath(inputPath, 'read');
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) throw new Error('Not a file');
        const handle = await fs.open(filePath, 'r');
        try {
          const size = Math.min(stat.size, limit);
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await handle.read(buffer, 0, size, 0);
          return { path: filePath, ok: true, size: stat.size, bytesRead, truncated: bytesRead < stat.size, content: encodeBuffer(buffer.subarray(0, bytesRead), encoding) };
        } finally {
          await handle.close();
        }
      } catch (error) {
        return { path: inputPath, ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return { files };
  });

  context.register(server, 'fs_write', {
    title: 'Write File',
    description: 'Create, replace or append a file. Supports atomic replacement and UTF-8/base64/hex input.',
    inputSchema: {
      path: z.string().min(1),
      content: z.string(),
      encoding: textEncoding,
      mode: z.enum(['rewrite', 'append', 'create-new']).default('rewrite'),
      createParents: z.boolean().default(true),
      atomic: z.boolean().default(true)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ path: inputPath, content, encoding, mode, createParents, atomic }) => {
    const filePath = await context.policy.assertPath(inputPath, 'write');
    const buffer = decodeContent(content, encoding);
    if (buffer.length > context.config.get().maxWriteBytes) throw new Error(`Write exceeds maxWriteBytes (${context.config.get().maxWriteBytes}).`);
    if (createParents) await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (mode === 'append') {
      await fs.appendFile(filePath, buffer);
    } else if (mode === 'create-new') {
      await fs.writeFile(filePath, buffer, { flag: 'wx' });
    } else if (atomic) {
      const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
      await fs.writeFile(temporary, buffer);
      await fs.rename(temporary, filePath);
    } else {
      await fs.writeFile(filePath, buffer);
    }
    const stat = await fs.stat(filePath);
    return { path: filePath, bytesWritten: buffer.length, size: stat.size, mode };
  });

  context.register(server, 'fs_patch', {
    title: 'Patch File',
    description: 'Apply an exact text replacement with an expected replacement count. Writes atomically.',
    inputSchema: {
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
      expectedReplacements: z.number().int().positive().default(1)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ path: inputPath, oldText, newText, expectedReplacements }) => {
    const filePath = await context.policy.assertPath(inputPath, 'patch');
    const stat = await fs.stat(filePath);
    if (stat.size > context.config.get().maxReadBytes) throw new Error('File is too large for exact text patching.');
    const original = await fs.readFile(filePath, 'utf8');
    const count = original.split(oldText).length - 1;
    if (count !== expectedReplacements) throw new Error(`Expected ${expectedReplacements} replacement(s), found ${count}.`);
    const updated = original.split(oldText).join(newText);
    if (Buffer.byteLength(updated) > context.config.get().maxWriteBytes) throw new Error('Patched file exceeds maxWriteBytes.');
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, updated, 'utf8');
    await fs.rename(temporary, filePath);
    return { path: filePath, replacements: count, bytesBefore: stat.size, bytesAfter: Buffer.byteLength(updated) };
  });

  context.register(server, 'fs_list', {
    title: 'List Directory',
    description: 'List a directory tree with depth, hidden-file and result-count controls.',
    inputSchema: {
      path: z.string().min(1),
      depth: z.number().int().min(1).max(100).default(1),
      maxEntries: z.number().int().positive().max(100_000).default(2_000),
      includeHidden: z.boolean().default(false)
    },
    annotations: { readOnlyHint: true }
  }, async ({ path: inputPath, depth, maxEntries, includeHidden }) => {
    const root = await context.policy.assertPath(inputPath, 'list');
    const entries = await listTree(root, depth, maxEntries, includeHidden);
    return { root, entries, count: entries.length, truncated: entries.length >= maxEntries };
  });

  context.register(server, 'fs_mkdir', {
    title: 'Create Directory',
    description: 'Create a directory, including missing parents.',
    inputSchema: { path: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, async ({ path: inputPath }) => {
    const directory = await context.policy.assertPath(inputPath, 'mkdir');
    await fs.mkdir(directory, { recursive: true });
    return { path: directory, created: true };
  });

  context.register(server, 'fs_copy', {
    title: 'Copy Path',
    description: 'Copy a file or directory recursively.',
    inputSchema: {
      source: z.string().min(1),
      destination: z.string().min(1),
      overwrite: z.boolean().default(false)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ source, destination, overwrite }) => {
    const from = await context.policy.assertPath(source, 'copy source');
    const to = await context.policy.assertPath(destination, 'copy destination');
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.cp(from, to, { recursive: true, force: overwrite, errorOnExist: !overwrite, preserveTimestamps: true });
    return { source: from, destination: to, overwritten: overwrite };
  });

  context.register(server, 'fs_move', {
    title: 'Move Path',
    description: 'Move or rename a file or directory.',
    inputSchema: {
      source: z.string().min(1),
      destination: z.string().min(1),
      overwrite: z.boolean().default(false)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ source, destination, overwrite }) => {
    const from = await context.policy.assertPath(source, 'move source');
    const to = await context.policy.assertPath(destination, 'move destination');
    if (!overwrite) {
      try {
        await fs.access(to);
        throw new Error(`Destination already exists: ${to}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else {
      await fs.rm(to, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    try {
      await fs.rename(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
      await fs.rm(from, { recursive: true, force: true });
    }
    return { source: from, destination: to };
  });

  context.register(server, 'fs_delete', {
    title: 'Delete Path',
    description: 'Delete a file or directory. Recursive directory deletion must be explicitly enabled.',
    inputSchema: {
      path: z.string().min(1),
      recursive: z.boolean().default(false),
      force: z.boolean().default(false)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ path: inputPath, recursive, force }) => {
    const target = await context.policy.assertPath(inputPath, 'delete');
    const parsed = path.parse(target);
    if (target === parsed.root) throw new Error('Refusing to delete a filesystem root through fs_delete. Use an explicit shell command under full profile if this is truly intended.');
    const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && force) return undefined;
      throw error;
    });
    if (!stat) return { path: target, deleted: false, reason: 'not-found' };
    if (stat.isDirectory() && !recursive) throw new Error('Target is a directory; set recursive=true.');
    await fs.rm(target, { recursive, force });
    return { path: target, deleted: true };
  });

  context.register(server, 'fs_stat', {
    title: 'File Information',
    description: 'Return detailed metadata for a file, directory or symbolic link.',
    inputSchema: { path: z.string().min(1), followSymlink: z.boolean().default(false) },
    annotations: { readOnlyHint: true }
  }, async ({ path: inputPath, followSymlink }) => {
    const target = await context.policy.assertPath(inputPath, 'stat');
    const stat = followSymlink ? await fs.stat(target) : await fs.lstat(target);
    return {
      path: target,
      type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'other',
      size: stat.size,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      createdAt: stat.birthtime.toISOString(),
      modifiedAt: stat.mtime.toISOString(),
      accessedAt: stat.atime.toISOString(),
      changedAt: stat.ctime.toISOString()
    };
  });

  context.register(server, 'fs_hash', {
    title: 'Hash File',
    description: 'Calculate a streaming cryptographic hash of a file.',
    inputSchema: { path: z.string().min(1), algorithm: z.enum(['sha256', 'sha512', 'sha1', 'md5']).default('sha256') },
    annotations: { readOnlyHint: true }
  }, async ({ path: inputPath, algorithm }) => {
    const target = await context.policy.assertPath(inputPath, 'hash');
    const hash = createHash(algorithm);
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(target);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return { path: target, algorithm, digest: hash.digest('hex') };
  });

  context.register(server, 'fs_search', {
    title: 'Search Files',
    description: 'Recursively search file names or text content with literal or regular-expression matching.',
    inputSchema: {
      root: z.string().min(1),
      query: z.string().min(1),
      mode: z.enum(['name', 'content']).default('name'),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      maxDepth: z.number().int().min(0).max(100).default(20),
      maxResults: z.number().int().positive().optional(),
      includeHidden: z.boolean().default(false),
      extensions: z.array(z.string()).optional(),
      ignore: z.array(z.string()).optional()
    },
    annotations: { readOnlyHint: true }
  }, async (args) => context.search.search(args));
}
