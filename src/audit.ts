import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConfigStore } from './config.js';

const SENSITIVE_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i;
const CONTENT_KEY = /(content|body|data|input)/i;

function truncate(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
}

export function sanitizeForAudit(value: unknown, key = '', depth = 0): unknown {
  if (depth > 5) return '[max-depth]';
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return CONTENT_KEY.test(key) ? truncate(value, 500) : truncate(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForAudit(item, key, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, sanitizeForAudit(childValue, childKey, depth + 1)])
    );
  }
  return value;
}

export interface AuditEvent {
  tool: string;
  args?: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export class AuditLogger {
  constructor(private readonly configStore: ConfigStore) {}

  async write(event: AuditEvent): Promise<void> {
    const config = this.configStore.get();
    if (!config.auditEnabled) return;
    const record = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      profile: config.profile,
      ...event,
      args: sanitizeForAudit(event.args)
    };
    await fs.mkdir(path.dirname(config.auditPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(config.auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}
