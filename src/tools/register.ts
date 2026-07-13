import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';
import { registerAdminTools } from './admin.js';
import { registerConfigTools } from './config-tools.js';
import { registerDesktopTools } from './desktop.js';
import { registerDeveloperTools } from './developer.js';
import { registerFilesystemTools } from './filesystem.js';
import { registerNetworkTools } from './network.js';
import { registerProcessTools } from './process.js';
import { registerSystemTools } from './system.js';

export function registerAllTools(server: McpServer, context: ToolContext): void {
  registerConfigTools(server, context);
  registerAdminTools(server, context);
  registerDesktopTools(server, context);
  registerDeveloperTools(server, context);
  registerFilesystemTools(server, context);
  registerProcessTools(server, context);
  registerSystemTools(server, context);
  registerNetworkTools(server, context);
}
