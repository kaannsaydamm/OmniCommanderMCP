import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SecurityProfile = 'safe' | 'full';

export interface OmniConfig {
  profile: SecurityProfile;
  allowedRoots: string[];
  blockedCommandPatterns: string[];
  maxReadBytes: number;
  maxWriteBytes: number;
  maxOutputBytes: number;
  maxSearchResults: number;
  maxSearchFileBytes: number;
  maxWatchEvents: number;
  processTimeoutMs: number;
  sessionBufferBytes: number;
  allowNetwork: boolean;
  allowPrivateNetwork: boolean;
  allowEnvironmentRead: boolean;
  auditEnabled: boolean;
  auditPath: string;
  configPath: string;
}

export type ConfigPatch = Partial<Omit<OmniConfig, 'configPath'>>;

const SAFE_BLOCKED_COMMANDS = [
  String.raw`(^|[;&|]\s*)(rm\s+-rf\s+[/~](\s|$)|mkfs(\.|\s)|dd\s+if=.*\s+of=/dev/|shutdown(\.exe)?\b|reboot\b|poweroff\b)` ,
  String.raw`(^|[;&|]\s*)(format\s+[a-z]:|diskpart\b|bcdedit\b|del\s+/[a-z]*[fs][a-z]*\s+[a-z]:\\windows)` ,
  String.raw`:\(\)\s*\{\s*:\|:\s*&\s*\};\s*:`
];

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.omni-commander', 'config.json');
}

function defaultAuditPath(): string {
  return path.join(os.homedir(), '.omni-commander', 'audit.jsonl');
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.filter(Boolean).map((root) => path.resolve(root)))];
}

function safeDefaults(configPath: string): OmniConfig {
  return {
    profile: 'safe',
    allowedRoots: normalizeRoots([process.cwd(), os.homedir()]),
    blockedCommandPatterns: [...SAFE_BLOCKED_COMMANDS],
    maxReadBytes: 16 * 1024 * 1024,
    maxWriteBytes: 64 * 1024 * 1024,
    maxOutputBytes: 2 * 1024 * 1024,
    maxSearchResults: 500,
    maxSearchFileBytes: 2 * 1024 * 1024,
    maxWatchEvents: 10_000,
    processTimeoutMs: 30_000,
    sessionBufferBytes: 4 * 1024 * 1024,
    allowNetwork: true,
    allowPrivateNetwork: false,
    allowEnvironmentRead: false,
    auditEnabled: true,
    auditPath: defaultAuditPath(),
    configPath
  };
}

function fullDefaults(configPath: string): OmniConfig {
  return {
    ...safeDefaults(configPath),
    profile: 'full',
    allowedRoots: [],
    blockedCommandPatterns: [],
    maxReadBytes: 128 * 1024 * 1024,
    maxWriteBytes: 512 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxSearchResults: 5_000,
    maxSearchFileBytes: 16 * 1024 * 1024,
    maxWatchEvents: 100_000,
    processTimeoutMs: 120_000,
    sessionBufferBytes: 32 * 1024 * 1024,
    allowNetwork: true,
    allowPrivateNetwork: true,
    allowEnvironmentRead: true
  };
}

function parseProfile(value: string | undefined): SecurityProfile | undefined {
  if (value === 'safe' || value === 'full') return value;
  return undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  return undefined;
}

function parseCli(argv: string[]): { profile?: SecurityProfile; configPath?: string; allowedRoots?: string[] } {
  const result: { profile?: SecurityProfile; configPath?: string; allowedRoots?: string[] } = {};
  for (const arg of argv) {
    if (arg === '--full') result.profile = 'full';
    if (arg === '--safe') result.profile = 'safe';
    if (arg.startsWith('--profile=')) {
      const parsed = parseProfile(arg.slice('--profile='.length));
      if (parsed) result.profile = parsed;
    }
    if (arg.startsWith('--config=')) result.configPath = path.resolve(arg.slice('--config='.length));
    if (arg.startsWith('--allow-root=')) {
      result.allowedRoots ??= [];
      result.allowedRoots.push(path.resolve(arg.slice('--allow-root='.length)));
    }
  }
  return result;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw error;
  }
}

function mergeConfig(base: OmniConfig, patch: Record<string, unknown> | ConfigPatch): OmniConfig {
  const merged = { ...base, ...patch } as OmniConfig;
  merged.profile = parseProfile(String(merged.profile)) ?? base.profile;
  merged.allowedRoots = normalizeRoots(Array.isArray(merged.allowedRoots) ? merged.allowedRoots.map(String) : base.allowedRoots);
  merged.blockedCommandPatterns = Array.isArray(merged.blockedCommandPatterns)
    ? merged.blockedCommandPatterns.map(String)
    : base.blockedCommandPatterns;
  merged.configPath = base.configPath;
  return merged;
}

export async function loadConfig(argv = process.argv.slice(2)): Promise<OmniConfig> {
  const cli = parseCli(argv);
  const configPath = cli.configPath ?? process.env.OMNI_CONFIG_PATH ?? defaultConfigPath();
  const envProfile = parseProfile(process.env.OMNI_PROFILE);
  const fileConfig = await readJsonFile(configPath);
  const fileProfile = parseProfile(typeof fileConfig.profile === 'string' ? fileConfig.profile : undefined);
  const profile = cli.profile ?? envProfile ?? fileProfile ?? 'safe';

  let config = profile === 'full' ? fullDefaults(configPath) : safeDefaults(configPath);
  config = mergeConfig(config, fileConfig);

  if (cli.profile || envProfile) {
    const requested = cli.profile ?? envProfile;
    config = mergeConfig(requested === 'full' ? fullDefaults(configPath) : safeDefaults(configPath), fileConfig);
    config.profile = requested ?? config.profile;
  }

  const envRoots = process.env.OMNI_ALLOWED_ROOTS
    ? process.env.OMNI_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean)
    : undefined;
  if (envRoots) config.allowedRoots = normalizeRoots(envRoots);
  if (cli.allowedRoots?.length) config.allowedRoots = normalizeRoots(cli.allowedRoots);

  const auditEnabled = parseBoolean(process.env.OMNI_AUDIT_ENABLED);
  if (auditEnabled !== undefined) config.auditEnabled = auditEnabled;

  return config;
}

export class ConfigStore {
  private value: OmniConfig;

  constructor(initial: OmniConfig) {
    this.value = initial;
  }

  get(): Readonly<OmniConfig> {
    return this.value;
  }

  async update(patch: ConfigPatch, persist = true): Promise<Readonly<OmniConfig>> {
    const nextProfile = patch.profile ?? this.value.profile;
    const profileChanged = nextProfile !== this.value.profile;
    const defaults = nextProfile === 'full' ? fullDefaults(this.value.configPath) : safeDefaults(this.value.configPath);
    const base = profileChanged ? defaults : this.value;
    this.value = mergeConfig({ ...defaults, configPath: this.value.configPath }, { ...base, ...patch, profile: nextProfile });
    if (persist) await this.persist();
    return this.value;
  }

  async persist(): Promise<void> {
    const directory = path.dirname(this.value.configPath);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const { configPath: _configPath, ...persisted } = this.value;
    const temporary = `${this.value.configPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.value.configPath);
  }
}
