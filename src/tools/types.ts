import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConfigStore } from '../config.js';
import type { PolicyEngine } from '../policy.js';
import type { AuditLogger } from '../audit.js';
import type { SessionManager } from '../managers/session-manager.js';
import type { SearchManager } from '../managers/search-manager.js';
import type { WatchManager } from '../managers/watch-manager.js';
import { errorMessage, jsonResult } from '../utils/result.js';

export type ToolHandler = (args: any, extra?: any) => Promise<unknown> | unknown;
export type RawToolHandler = (args: any, extra?: any) => Promise<CallToolResult> | CallToolResult;

export interface ToolContext {
  config: ConfigStore;
  policy: PolicyEngine;
  audit: AuditLogger;
  sessions: SessionManager;
  search: SearchManager;
  watches: WatchManager;
  register: (
    server: McpServer,
    name: string,
    definition: Record<string, unknown>,
    handler: ToolHandler
  ) => void;
  registerRaw: (
    server: McpServer,
    name: string,
    definition: Record<string, unknown>,
    handler: RawToolHandler
  ) => void;
}

export function createToolContext(
  config: ConfigStore,
  policy: PolicyEngine,
  audit: AuditLogger,
  sessions: SessionManager,
  search: SearchManager,
  watches: WatchManager
): ToolContext {
  const context = {} as ToolContext;
  context.config = config;
  context.policy = policy;
  context.audit = audit;
  context.sessions = sessions;
  context.search = search;
  context.watches = watches;

  const runAudited = async <T>(name: string, args: unknown, handler: () => Promise<T>): Promise<T | CallToolResult> => {
    const startedAt = Date.now();
    try {
      const output = await handler();
      await audit.write({ tool: name, args, ok: true, durationMs: Date.now() - startedAt });
      return output;
    } catch (error) {
      const message = errorMessage(error);
      await audit.write({ tool: name, args, ok: false, durationMs: Date.now() - startedAt, error: message }).catch(() => undefined);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: message }]
      };
    }
  };

  context.register = (server, name, definition, handler) => {
    (server.registerTool as any)(name, definition, async (args: unknown, extra: unknown) => {
      const result = await runAudited(name, args, async () => handler(args, extra));
      if (result && typeof result === 'object' && 'isError' in result && 'content' in result) return result;
      return jsonResult(result);
    });
  };

  context.registerRaw = (server, name, definition, handler) => {
    (server.registerTool as any)(name, definition, async (args: unknown, extra: unknown) => {
      return runAudited(name, args, async () => handler(args, extra));
    });
  };

  return context;
}
