import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';

const execFileAsync = promisify(execFile);

async function commandExists(command: string): Promise<boolean> {
  const checker = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    await execFileAsync(checker, [command], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function clipboardRead(): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'Get-Clipboard -Raw'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('pbpaste', [], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }
  if (await commandExists('wl-paste')) {
    const { stdout } = await execFileAsync('wl-paste', ['--no-newline'], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }
  if (await commandExists('xclip')) {
    const { stdout } = await execFileAsync('xclip', ['-selection', 'clipboard', '-o'], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }
  throw new Error('No supported clipboard command found (wl-paste or xclip).');
}

async function clipboardWrite(text: string): Promise<void> {
  if (process.platform === 'win32') {
    const child = execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', '$input | Set-Clipboard'], { windowsHide: true });
    child.stdin?.end(text);
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`PowerShell clipboard exited with code ${code}`)));
    });
    return;
  }
  const command = process.platform === 'darwin' ? 'pbcopy' : await commandExists('wl-copy') ? 'wl-copy' : await commandExists('xclip') ? 'xclip' : '';
  if (!command) throw new Error('No supported clipboard command found (wl-copy or xclip).');
  const args = command === 'xclip' ? ['-selection', 'clipboard'] : [];
  const child = execFile(command, args);
  child.stdin?.end(text);
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)));
  });
}

async function takeScreenshot(outputPath: string): Promise<void> {
  if (process.platform === 'win32') {
    const escaped = outputPath.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
      `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose()',
      '$bmp.Dispose()'
    ].join('; ');
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-Sta', '-Command', script], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
    return;
  }
  if (process.platform === 'darwin') {
    await execFileAsync('screencapture', ['-x', outputPath]);
    return;
  }
  if (await commandExists('grim')) {
    await execFileAsync('grim', [outputPath]);
    return;
  }
  if (await commandExists('gnome-screenshot')) {
    await execFileAsync('gnome-screenshot', ['-f', outputPath]);
    return;
  }
  if (await commandExists('scrot')) {
    await execFileAsync('scrot', [outputPath]);
    return;
  }
  throw new Error('No supported screenshot backend found (grim, gnome-screenshot or scrot).');
}

export function registerSystemTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'system_info', {
    title: 'System Information',
    description: 'Return operating-system, CPU, memory, network-interface, runtime and server configuration information.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => ({
    platform: process.platform,
    architecture: process.arch,
    release: os.release(),
    version: os.version(),
    hostname: os.hostname(),
    username: os.userInfo().username,
    homedir: os.homedir(),
    cwd: process.cwd(),
    uptimeSeconds: os.uptime(),
    cpuCount: os.cpus().length,
    cpus: os.cpus().map((cpu) => ({ model: cpu.model, speedMHz: cpu.speed })),
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    networkInterfaces: os.networkInterfaces(),
    nodeVersion: process.version,
    processId: process.pid,
    config: context.config.get()
  }));

  context.register(server, 'env_get', {
    title: 'Read Environment Variables',
    description: 'Read one environment variable or list environment-variable names. Full values require environment-read permission.',
    inputSchema: {
      name: z.string().optional(),
      listNamesOnly: z.boolean().default(false),
      prefix: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ name, listNamesOnly, prefix }) => {
    if (listNamesOnly) {
      const names = Object.keys(process.env).filter((key) => !prefix || key.startsWith(prefix)).sort();
      return { names };
    }
    context.policy.assertEnvironmentRead();
    if (name) return { name, value: process.env[name] };
    const entries = Object.fromEntries(Object.entries(process.env).filter(([key]) => !prefix || key.startsWith(prefix)));
    return { environment: entries };
  });

  context.register(server, 'env_set', {
    title: 'Set Server Environment Variable',
    description: 'Set or unset an environment variable for this MCP server and child processes started afterward.',
    inputSchema: { name: z.string().min(1), value: z.string().nullable() },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ name, value }) => {
    if (context.config.get().profile !== 'full') throw new Error('env_set is available only in full profile.');
    if (value === null) delete process.env[name];
    else process.env[name] = value;
    return { name, set: value !== null };
  });

  context.register(server, 'clipboard_read', {
    title: 'Read Clipboard',
    description: 'Read text from the operating-system clipboard.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => ({ text: await clipboardRead() }));

  context.register(server, 'clipboard_write', {
    title: 'Write Clipboard',
    description: 'Replace the operating-system clipboard with text.',
    inputSchema: { text: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true }
  }, async ({ text }) => {
    await clipboardWrite(text);
    return { bytesWritten: Buffer.byteLength(text, 'utf8') };
  });

  context.register(server, 'desktop_screenshot', {
    title: 'Capture Desktop Screenshot',
    description: 'Capture the virtual desktop to a PNG and optionally return it as MCP image content through the file path.',
    inputSchema: {
      outputPath: z.string().optional(),
      includeBase64: z.boolean().default(false)
    },
    annotations: { readOnlyHint: true }
  }, async ({ outputPath, includeBase64 }) => {
    const requested = outputPath ?? path.join(os.tmpdir(), `omni-screenshot-${Date.now()}.png`);
    const target = await context.policy.assertPath(requested, 'screenshot output');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await takeScreenshot(target);
    const stat = await fs.stat(target);
    const result: Record<string, unknown> = { path: target, size: stat.size, mimeType: 'image/png' };
    if (includeBase64) {
      if (stat.size > context.config.get().maxReadBytes) throw new Error('Screenshot exceeds maxReadBytes for base64 return.');
      result.base64 = (await fs.readFile(target)).toString('base64');
    }
    return result;
  });

  context.register(server, 'desktop_open', {
    title: 'Open File or URL',
    description: 'Open a file, directory or URL with the operating-system default application.',
    inputSchema: { target: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ target }) => {
    let resolved = target;
    if (/^https?:\/\//i.test(target)) {
      await context.policy.assertUrl(target);
    } else {
      resolved = await context.policy.assertPath(target, 'open');
    }
    if (process.platform === 'win32') {
      await execFileAsync('cmd.exe', ['/d', '/s', '/c', 'start', '', resolved], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      await execFileAsync('open', [resolved]);
    } else {
      await execFileAsync('xdg-open', [resolved]);
    }
    return { target: resolved, opened: true };
  });
}
