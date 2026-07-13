import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';

function headersToObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

async function readResponseBody(response: Response, maxBytes: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (!response.body) return { buffer: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (total + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, Math.max(0, maxBytes - total)));
        total = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    reader.releaseLock();
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

export function registerNetworkTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'http_request', {
    title: 'HTTP Request',
    description: 'Perform an HTTP(S) request with redirect, timeout and response-size controls. Safe mode blocks private-network targets.',
    inputSchema: {
      url: z.string().url(),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      bodyEncoding: z.enum(['utf8', 'base64']).default('utf8'),
      responseEncoding: z.enum(['utf8', 'base64', 'hex']).default('utf8'),
      timeoutMs: z.number().int().positive().max(300_000).default(30_000),
      maxBytes: z.number().int().positive().optional(),
      redirect: z.enum(['follow', 'error', 'manual']).default('follow')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ url: inputUrl, method, headers, body, bodyEncoding, responseEncoding, timeoutMs, maxBytes, redirect }) => {
    const url = await context.policy.assertUrl(inputUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const requestInit: RequestInit = { method, headers, redirect, signal: controller.signal };
      if (body !== undefined) requestInit.body = Buffer.from(body, bodyEncoding);
      const response = await fetch(url, requestInit);
      const cap = Math.min(maxBytes ?? context.config.get().maxReadBytes, context.config.get().maxReadBytes);
      const { buffer, truncated } = await readResponseBody(response, cap);
      return {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: headersToObject(response.headers),
        bytesRead: buffer.length,
        truncated,
        encoding: responseEncoding,
        body: buffer.toString(responseEncoding)
      };
    } finally {
      clearTimeout(timer);
    }
  });

  context.register(server, 'http_download', {
    title: 'Download File',
    description: 'Download an HTTP(S) resource to disk using a temporary file and atomic rename.',
    inputSchema: {
      url: z.string().url(),
      destination: z.string().min(1),
      headers: z.record(z.string()).optional(),
      timeoutMs: z.number().int().positive().max(900_000).default(120_000),
      overwrite: z.boolean().default(false),
      maxBytes: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ url: inputUrl, destination, headers, timeoutMs, overwrite, maxBytes }) => {
    const url = await context.policy.assertUrl(inputUrl);
    const target = await context.policy.assertPath(destination, 'download destination');
    if (!overwrite) {
      try {
        await fs.access(target);
        throw new Error(`Destination already exists: ${target}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(path.dirname(target), { recursive: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const temporary = `${target}.${process.pid}.${Date.now()}.download`;
    try {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
      const cap = Math.min(maxBytes ?? context.config.get().maxWriteBytes, context.config.get().maxWriteBytes);
      const { buffer, truncated } = await readResponseBody(response, cap + 1);
      if (truncated || buffer.length > cap) throw new Error(`Download exceeds configured limit of ${cap} bytes.`);
      await fs.writeFile(temporary, buffer);
      if (overwrite) await fs.rm(target, { force: true, recursive: true });
      await fs.rename(temporary, target);
      return { url: response.url, destination: target, bytesWritten: buffer.length, headers: headersToObject(response.headers) };
    } finally {
      clearTimeout(timer);
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}
