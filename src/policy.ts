import { promises as fs } from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import type { ConfigStore } from './config.js';

export class PolicyError extends Error {
  readonly code = 'POLICY_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

function normalizeForComparison(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function expandPath(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

async function canonicalizeExistingOrParent(input: string): Promise<string> {
  const absolute = expandPath(input);
  let current = absolute;
  const suffix: string[] = [];

  while (true) {
    try {
      const real = await fs.realpath(current);
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(root);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
}

export class PolicyEngine {
  constructor(private readonly configStore: ConfigStore) {}

  async assertPath(input: string, operation = 'access'): Promise<string> {
    const config = this.configStore.get();
    const canonical = await canonicalizeExistingOrParent(input);
    if (config.profile === 'full' || config.allowedRoots.length === 0) return canonical;

    for (const root of config.allowedRoots) {
      const canonicalRoot = await canonicalizeExistingOrParent(root);
      if (isWithin(canonical, canonicalRoot)) return canonical;
    }

    throw new PolicyError(`Path denied for ${operation}: ${canonical}. Allowed roots: ${config.allowedRoots.join(', ')}`);
  }

  assertCommand(command: string): void {
    const config = this.configStore.get();
    if (config.profile === 'full') return;
    for (const pattern of config.blockedCommandPatterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        throw new PolicyError(`Invalid blocked command pattern in configuration: ${pattern}`);
      }
      if (regex.test(command)) throw new PolicyError(`Command denied by safe profile pattern: ${pattern}`);
    }
  }

  async assertUrl(input: string): Promise<URL> {
    const config = this.configStore.get();
    if (!config.allowNetwork) throw new PolicyError('Network access is disabled by configuration.');

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new PolicyError(`Invalid URL: ${input}`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new PolicyError(`Unsupported URL protocol: ${url.protocol}`);
    if (config.allowPrivateNetwork || config.profile === 'full') return url;

    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
      throw new PolicyError('Safe profile blocks localhost network access.');
    }

    const directIp = net.isIP(url.hostname) ? [url.hostname] : [];
    const resolved = directIp.length > 0 ? directIp : (await dns.lookup(url.hostname, { all: true })).map((entry) => entry.address);
    if (resolved.some(isPrivateIp)) throw new PolicyError(`Safe profile blocks private or loopback network target: ${url.hostname}`);
    return url;
  }

  assertEnvironmentRead(): void {
    const config = this.configStore.get();
    if (!config.allowEnvironmentRead && config.profile !== 'full') {
      throw new PolicyError('Environment variable reads are disabled in the safe profile.');
    }
  }
}
