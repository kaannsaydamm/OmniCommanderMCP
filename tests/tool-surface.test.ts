import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((value) => fs.rm(value, { recursive: true, force: true })));
});

describe('MCP tool surface', () => {
  it('registers terminal, desktop, accessibility, networking and OS administration tools', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-tools-'));
    temporaryPaths.push(base);
    const runtime = await createServer([`--config=${path.join(base, 'config.json')}`, '--full']);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'omni-test-client', version: '1.0.0' }, { capabilities: {} });
    await runtime.server.connect(serverTransport as any);
    await client.connect(clientTransport as any);
    const response = await client.listTools();
    const names = response.tools.map((tool) => tool.name);

    expect(names.length).toBeGreaterThanOrEqual(55);
    expect(names).toEqual(expect.arrayContaining([
      'shell_exec', 'process_start', 'fs_read', 'http_request',
      'computer_observe', 'computer_sequence', 'computer_click_text', 'accessibility_snapshot',
      'window_control', 'application_launch', 'service_control', 'package_manage',
      'scheduled_task_manage', 'firewall_rule', 'power_control'
    ]));

    await client.close();
    await runtime.server.close();
  });
});
