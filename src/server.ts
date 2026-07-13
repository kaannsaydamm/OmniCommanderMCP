import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuditLogger } from './audit.js';
import { ConfigStore, loadConfig } from './config.js';
import { SessionManager } from './managers/session-manager.js';
import { SearchManager } from './managers/search-manager.js';
import { PolicyEngine } from './policy.js';
import { registerAllTools } from './tools/register.js';
import { createToolContext } from './tools/types.js';

export async function createServer(argv = process.argv.slice(2)): Promise<{ server: McpServer; config: ConfigStore; sessions: SessionManager }> {
  const initialConfig = await loadConfig(argv);
  const config = new ConfigStore(initialConfig);
  const policy = new PolicyEngine(config);
  const audit = new AuditLogger(config);
  const sessions = new SessionManager(config, policy);
  const search = new SearchManager(config, policy);
  const context = createToolContext(config, policy, audit, sessions, search);

  const server = new McpServer({
    name: 'omni-commander-mcp',
    version: '0.2.0',
    title: 'Omni Commander MCP'
  });

  registerAllTools(server, context);
  return { server, config, sessions };
}

export async function runStdio(argv = process.argv.slice(2)): Promise<void> {
  const { server, config, sessions } = await createServer(argv);
  const transport = new StdioServerTransport();

  const cleanupTimer = setInterval(() => {
    sessions.cleanup();
  }, 30 * 60_000);
  cleanupTimer.unref?.();

  process.stderr.write(`[omni-commander] profile=${config.get().profile} audit=${config.get().auditEnabled ? config.get().auditPath : 'disabled'}\n`);
  await server.connect(transport);
}
