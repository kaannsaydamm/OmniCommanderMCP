import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { NextFunction, Request, Response } from 'express';
import { createServer } from './server.js';
import type { SessionManager } from './managers/session-manager.js';

interface HttpOptions {
  host: string;
  port: number;
  token?: string;
  allowedHosts?: string[];
}

interface ActiveTransport {
  transport: StreamableHTTPServerTransport;
  sessions: SessionManager;
}

function cliValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function parseHttpOptions(argv: string[]): HttpOptions {
  const host = cliValue(argv, 'host') ?? process.env.OMNI_HTTP_HOST ?? '127.0.0.1';
  const portRaw = cliValue(argv, 'port') ?? process.env.OMNI_HTTP_PORT ?? '8787';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid HTTP port: ${portRaw}`);
  const token = cliValue(argv, 'token') ?? process.env.OMNI_HTTP_TOKEN;
  const allowedHostsRaw = cliValue(argv, 'allowed-hosts') ?? process.env.OMNI_HTTP_ALLOWED_HOSTS;
  const allowedHosts = allowedHostsRaw?.split(',').map((value) => value.trim()).filter(Boolean);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && !token) throw new Error('A bearer token is required when the HTTP server binds outside loopback. Set OMNI_HTTP_TOKEN or --token=.');
  const result: HttpOptions = { host, port };
  if (token) result.token = token;
  if (allowedHosts?.length) result.allowedHosts = allowedHosts;
  return result;
}

function tokenMatches(expected: string, supplied: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function authMiddleware(token?: string) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!token) { next(); return; }
    const authorization = request.header('authorization') ?? '';
    const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!supplied || !tokenMatches(token, supplied)) {
      response.status(401).setHeader('WWW-Authenticate', 'Bearer realm="omni-commander"').json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

export async function runHttp(argv = process.argv.slice(2)): Promise<void> {
  const options = parseHttpOptions(argv);
  const appOptions: { host: string; allowedHosts?: string[] } = { host: options.host };
  if (options.allowedHosts) appOptions.allowedHosts = options.allowedHosts;
  const app = createMcpExpressApp(appOptions);
  const transports = new Map<string, ActiveTransport>();

  app.get('/healthz', (_request, response) => response.json({ ok: true, service: 'omni-commander-mcp', sessions: transports.size }));
  app.get('/readyz', (_request, response) => response.json({ ready: true, service: 'omni-commander-mcp' }));
  app.use('/mcp', authMiddleware(options.token));

  app.post('/mcp', async (request: Request, response: Response) => {
    const sessionId = request.header('mcp-session-id');
    try {
      if (sessionId) {
        const active = transports.get(sessionId);
        if (!active) { response.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown MCP session' }, id: null }); return; }
        await active.transport.handleRequest(request, response, request.body);
        return;
      }
      if (!isInitializeRequest(request.body)) {
        response.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Expected MCP initialize request' }, id: null });
        return;
      }

      const runtime = await createServer(argv);
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedId) => { transports.set(initializedId, { transport, sessions: runtime.sessions }); }
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) transports.delete(id);
      };
      transport.onerror = (error) => process.stderr.write(`[omni-commander:http] transport error: ${error.message}\n`);
      await runtime.server.connect(transport as any);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[omni-commander:http] request error: ${message}\n`);
      if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message }, id: null });
    }
  });

  app.get('/mcp', async (request: Request, response: Response) => {
    const sessionId = request.header('mcp-session-id');
    const active = sessionId ? transports.get(sessionId) : undefined;
    if (!active) { response.status(404).send('Unknown MCP session'); return; }
    await active.transport.handleRequest(request, response);
  });

  app.delete('/mcp', async (request: Request, response: Response) => {
    const sessionId = request.header('mcp-session-id');
    const active = sessionId ? transports.get(sessionId) : undefined;
    if (!active) { response.status(404).send('Unknown MCP session'); return; }
    await active.transport.handleRequest(request, response);
    if (sessionId) transports.delete(sessionId);
  });

  const httpServer: HttpServer = app.listen(options.port, options.host, () => {
    process.stderr.write(`[omni-commander:http] listening=http://${options.host}:${options.port}/mcp auth=${options.token ? 'bearer' : 'loopback-only'}\n`);
  });

  const cleanupTimer = setInterval(() => {
    for (const active of transports.values()) active.sessions.cleanup();
  }, 30 * 60_000);
  cleanupTimer.unref?.();

  const shutdown = async (): Promise<void> => {
    clearInterval(cleanupTimer);
    for (const active of transports.values()) await active.transport.close().catch(() => undefined);
    transports.clear();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
}
