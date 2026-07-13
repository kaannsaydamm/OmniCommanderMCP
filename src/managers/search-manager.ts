import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConfigStore } from '../config.js';
import type { PolicyEngine } from '../policy.js';

export interface SearchOptions {
  root: string;
  query: string;
  mode: 'name' | 'content';
  regex?: boolean;
  caseSensitive?: boolean;
  maxDepth?: number;
  maxResults?: number;
  includeHidden?: boolean;
  extensions?: string[];
  ignore?: string[];
}

interface SearchResult {
  path: string;
  type: 'file' | 'directory';
  line?: number;
  preview?: string;
}

function isHidden(name: string): boolean {
  return name.startsWith('.') && name !== '.' && name !== '..';
}

function compileMatcher(query: string, regex: boolean, caseSensitive: boolean): RegExp {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(source, caseSensitive ? '' : 'i');
}

function matchesExtension(filePath: string, extensions?: string[]): boolean {
  if (!extensions?.length) return true;
  const ext = path.extname(filePath).toLowerCase();
  return extensions.some((value) => {
    const normalized = value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`;
    return normalized === ext;
  });
}

function shouldIgnore(relativePath: string, ignore: string[]): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  return ignore.some((pattern) => {
    const clean = pattern.replace(/^\.\//, '').replace(/\*\*/g, '').replace(/\*/g, '');
    return clean.length > 0 && normalized.includes(clean);
  });
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  return sample.includes(0);
}

export class SearchManager {
  constructor(
    private readonly configStore: ConfigStore,
    private readonly policy: PolicyEngine
  ) {}

  async search(options: SearchOptions): Promise<Record<string, unknown>> {
    const root = await this.policy.assertPath(options.root, 'search');
    const matcher = compileMatcher(options.query, options.regex ?? false, options.caseSensitive ?? false);
    const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 20, 100));
    const maxResults = Math.max(1, Math.min(options.maxResults ?? this.configStore.get().maxSearchResults, this.configStore.get().maxSearchResults));
    const ignore = options.ignore ?? ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];
    const results: SearchResult[] = [];
    let filesVisited = 0;
    let directoriesVisited = 0;
    let denied = 0;
    let truncated = false;

    const walk = async (directory: string, depth: number): Promise<void> => {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      directoriesVisited += 1;
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        denied += 1;
        return;
      }

      for (const entry of entries) {
        if (results.length >= maxResults) {
          truncated = true;
          return;
        }
        if (!options.includeHidden && isHidden(entry.name)) continue;
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute);
        if (shouldIgnore(relative, ignore)) continue;

        if (options.mode === 'name' && matcher.test(entry.name)) {
          results.push({ path: absolute, type: entry.isDirectory() ? 'directory' : 'file' });
        }

        if (entry.isDirectory()) {
          if (depth < maxDepth) await walk(absolute, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        filesVisited += 1;
        if (options.mode !== 'content' || !matchesExtension(absolute, options.extensions)) continue;

        try {
          const stat = await fs.stat(absolute);
          if (stat.size > this.configStore.get().maxSearchFileBytes) continue;
          const buffer = await fs.readFile(absolute);
          if (looksBinary(buffer)) continue;
          const lines = buffer.toString('utf8').split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            matcher.lastIndex = 0;
            if (!matcher.test(line)) continue;
            results.push({ path: absolute, type: 'file', line: index + 1, preview: line.trim().slice(0, 500) });
            if (results.length >= maxResults) {
              truncated = true;
              return;
            }
          }
        } catch {
          denied += 1;
        }
      }
    };

    await walk(root, 0);
    return { root, query: options.query, mode: options.mode, results, summary: { filesVisited, directoriesVisited, denied, truncated, count: results.length } };
  }
}
