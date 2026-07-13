import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';

const configPatchSchema = {
  profile: z.enum(['safe', 'full']).optional(),
  allowedRoots: z.array(z.string()).optional(),
  blockedCommandPatterns: z.array(z.string()).optional(),
  maxReadBytes: z.number().int().positive().optional(),
  maxWriteBytes: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  maxSearchResults: z.number().int().positive().optional(),
  maxSearchFileBytes: z.number().int().positive().optional(),
  processTimeoutMs: z.number().int().min(0).optional(),
  sessionBufferBytes: z.number().int().positive().optional(),
  allowNetwork: z.boolean().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  allowEnvironmentRead: z.boolean().optional(),
  auditEnabled: z.boolean().optional(),
  auditPath: z.string().optional()
};

export function registerConfigTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'config_get', {
    title: 'Get Configuration',
    description: 'Return the active Omni Commander configuration, security profile and storage paths.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => context.config.get());

  context.register(server, 'config_set', {
    title: 'Update Configuration',
    description: 'Update and optionally persist the server configuration. Changing to full removes application-level path and command restrictions.',
    inputSchema: {
      patch: z.object(configPatchSchema),
      persist: z.boolean().default(true)
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ patch, persist }) => context.config.update(patch, persist));
}
