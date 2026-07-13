import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';

const execFileAsync = promisify(execFile);

interface CommandResult { command: string; args: string[]; stdout: string; stderr: string }

async function exec(command: string, args: string[] = [], maxBuffer = 32 * 1024 * 1024): Promise<CommandResult> {
  const result = await execFileAsync(command, args, { windowsHide: true, maxBuffer });
  return { command, args, stdout: result.stdout, stderr: result.stderr };
}

async function ps(script: string): Promise<CommandResult> {
  return exec(process.env.OMNI_POWERSHELL || 'powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
}

function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function requireFull(context: ToolContext, operation: string): void {
  if (context.config.get().profile !== 'full') throw new Error(`${operation} requires the full security profile.`);
}

async function exists(command: string): Promise<boolean> {
  try { await exec(process.platform === 'win32' ? 'where.exe' : 'which', [command], 1024 * 1024); return true; } catch { return false; }
}

async function privilegeStatus(): Promise<Record<string, unknown>> {
  if (process.platform === 'win32') {
    const script = '$id=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($id);[pscustomobject]@{user=$id.Name;isAdministrator=$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);integrity=(whoami /groups | Select-String "Mandatory Label") -join "`n"}|ConvertTo-Json -Compress';
    return JSON.parse((await ps(script)).stdout.trim() || '{}') as Record<string, unknown>;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const sudo = await exists('sudo') ? (await exec('sudo', ['-n', 'true']).then(() => true).catch(() => false)) : false;
  return { user: os.userInfo().username, uid, isRoot: uid === 0, passwordlessSudo: sudo };
}

async function listServices(query?: string): Promise<unknown> {
  if (process.platform === 'win32') {
    const filter = query ? ` | Where-Object {$_.Name -like ${psQuote(`*${query}*`)} -or $_.DisplayName -like ${psQuote(`*${query}*`)}}` : '';
    const out = await ps(`Get-CimInstance Win32_Service${filter} | Select-Object Name,DisplayName,State,StartMode,ProcessId,PathName,StartName | ConvertTo-Json -Depth 3 -Compress`);
    return JSON.parse(out.stdout.trim() || '[]') as unknown;
  }
  if (process.platform === 'darwin') {
    const out = await exec('launchctl', ['list']);
    const lines = out.stdout.split(/\r?\n/).filter(Boolean);
    const rows = lines.slice(1).map((line) => {
      const [pid = '-', status = '-', ...label] = line.trim().split(/\s+/);
      return { pid: pid === '-' ? null : Number(pid), status: Number(status), label: label.join(' ') };
    });
    return query ? rows.filter((row) => row.label.toLowerCase().includes(query.toLowerCase())) : rows;
  }
  const out = await exec('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--output=json']);
  const parsed = JSON.parse(out.stdout || '[]') as unknown[];
  return query ? parsed.filter((item) => JSON.stringify(item).toLowerCase().includes(query.toLowerCase())) : parsed;
}

async function serviceControl(name: string, action: string, scope: 'system' | 'user'): Promise<CommandResult> {
  if (process.platform === 'win32') {
    const commands: Record<string, string> = {
      start: `Start-Service -Name ${psQuote(name)}`,
      stop: `Stop-Service -Name ${psQuote(name)} -Force`,
      restart: `Restart-Service -Name ${psQuote(name)} -Force`,
      enable: `Set-Service -Name ${psQuote(name)} -StartupType Automatic`,
      disable: `Set-Service -Name ${psQuote(name)} -StartupType Disabled`
    };
    return ps(commands[action] ?? 'throw "Unsupported action"');
  }
  if (process.platform === 'darwin') {
    const domain = scope === 'user' ? `gui/${typeof process.getuid === 'function' ? process.getuid() : 501}` : 'system';
    if (action === 'start' || action === 'restart') return exec('launchctl', ['kickstart', ...(action === 'restart' ? ['-k'] : []), `${domain}/${name}`]);
    if (action === 'stop') return exec('launchctl', ['kill', 'SIGTERM', `${domain}/${name}`]);
    return exec('launchctl', [action, `${domain}/${name}`]);
  }
  const prefix = scope === 'user' ? ['--user'] : [];
  const command = scope === 'system' && typeof process.getuid === 'function' && process.getuid() !== 0 && await exists('sudo') ? 'sudo' : 'systemctl';
  const args = command === 'sudo' ? ['-n', 'systemctl', ...prefix, action, name] : [...prefix, action, name];
  return exec(command, args);
}

async function packageManager(): Promise<string> {
  const candidates = process.platform === 'win32' ? ['winget', 'choco', 'scoop'] : process.platform === 'darwin' ? ['brew', 'port'] : ['apt-get', 'dnf', 'pacman', 'zypper', 'apk', 'flatpak', 'snap'];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('No supported package manager was detected.');
}

async function packageCommand(manager: string, operation: string, packages: string[], query?: string): Promise<CommandResult> {
  const packageName = packages[0] ?? query ?? '';
  if (manager === 'winget') {
    const map: Record<string, string[]> = {
      list: ['list'], search: ['search', query ?? packageName], install: ['install', '--id', packageName, '-e', '--accept-package-agreements', '--accept-source-agreements'],
      uninstall: ['uninstall', '--id', packageName, '-e'], update: packages.length ? ['upgrade', '--id', packageName, '-e', '--accept-package-agreements', '--accept-source-agreements'] : ['upgrade', '--all', '--accept-package-agreements', '--accept-source-agreements']
    };
    return exec('winget', map[operation] ?? []);
  }
  if (manager === 'brew') {
    const map: Record<string, string[]> = { list: ['list', '--versions'], search: ['search', query ?? packageName], install: ['install', ...packages], uninstall: ['uninstall', ...packages], update: packages.length ? ['upgrade', ...packages] : ['upgrade'] };
    return exec('brew', map[operation] ?? []);
  }
  if (manager === 'apt-get') {
    if (operation === 'list') return exec('dpkg-query', ['-W', '-f=${binary:Package}\t${Version}\n']);
    if (operation === 'search') return exec('apt-cache', ['search', query ?? packageName]);
    const aptArgs = operation === 'install' ? ['install', '-y', ...packages] : operation === 'uninstall' ? ['remove', '-y', ...packages] : packages.length ? ['install', '--only-upgrade', '-y', ...packages] : ['upgrade', '-y'];
    const elevated = typeof process.getuid === 'function' && process.getuid() !== 0;
    return elevated ? exec('sudo', ['-n', 'apt-get', ...aptArgs]) : exec('apt-get', aptArgs);
  }
  if (manager === 'dnf') {
    const args = operation === 'list' ? ['list', 'installed'] : operation === 'search' ? ['search', query ?? packageName] : operation === 'install' ? ['install', '-y', ...packages] : operation === 'uninstall' ? ['remove', '-y', ...packages] : ['upgrade', '-y', ...packages];
    return typeof process.getuid === 'function' && process.getuid() !== 0 ? exec('sudo', ['-n', 'dnf', ...args]) : exec('dnf', args);
  }
  if (manager === 'pacman') {
    const args = operation === 'list' ? ['-Q'] : operation === 'search' ? ['-Ss', query ?? packageName] : operation === 'install' ? ['-S', '--noconfirm', ...packages] : operation === 'uninstall' ? ['-R', '--noconfirm', ...packages] : ['-Syu', '--noconfirm'];
    return typeof process.getuid === 'function' && process.getuid() !== 0 ? exec('sudo', ['-n', 'pacman', ...args]) : exec('pacman', args);
  }
  const opMap: Record<string, string> = { list: 'list', search: 'search', install: 'install', uninstall: 'remove', update: 'upgrade' };
  return exec(manager, [opMap[operation] ?? operation, ...packages, ...(query ? [query] : [])]);
}

async function diskInfo(): Promise<unknown> {
  if (process.platform === 'win32') {
    const out = await ps('Get-Disk | Select Number,FriendlyName,SerialNumber,PartitionStyle,OperationalStatus,HealthStatus,Size | ForEach-Object {$d=$_;$p=Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue | Select PartitionNumber,DriveLetter,Type,Size;[pscustomobject]@{disk=$d;partitions=$p}} | ConvertTo-Json -Depth 6 -Compress');
    return JSON.parse(out.stdout.trim() || '[]') as unknown;
  }
  if (process.platform === 'darwin') return { raw: (await exec('diskutil', ['list'])).stdout, filesystems: (await exec('df', ['-h'])).stdout };
  if (await exists('lsblk')) return JSON.parse((await exec('lsblk', ['-J', '-O', '-b'])).stdout) as unknown;
  return { raw: (await exec('df', ['-h'])).stdout };
}

async function userList(): Promise<unknown> {
  if (process.platform === 'win32') return JSON.parse((await ps('Get-LocalUser | Select Name,Enabled,LastLogon,PasswordRequired,PasswordExpires,UserMayChangePassword,SID | ConvertTo-Json -Compress')).stdout.trim() || '[]') as unknown;
  if (process.platform === 'darwin') return { users: (await exec('dscl', ['.', '-list', '/Users', 'UniqueID'])).stdout, groups: (await exec('dscl', ['.', '-list', '/Groups', 'PrimaryGroupID'])).stdout };
  return { users: (await exec('getent', ['passwd'])).stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [name, , uid, gid, gecos, home, shell] = line.split(':'); return { name, uid: Number(uid), gid: Number(gid), gecos, home, shell }; }), groups: (await exec('getent', ['group'])).stdout.split(/\r?\n/).filter(Boolean) };
}

async function installedApplications(query?: string): Promise<unknown> {
  if (process.platform === 'win32') {
    const q = query ? ` | Where-Object {$_.DisplayName -like ${psQuote(`*${query}*`)}}` : '';
    const script = `$paths=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');Get-ItemProperty $paths -ErrorAction SilentlyContinue${q} | Where-Object DisplayName | Select DisplayName,DisplayVersion,Publisher,InstallLocation,UninstallString | Sort DisplayName -Unique | ConvertTo-Json -Compress`;
    return JSON.parse((await ps(script)).stdout.trim() || '[]') as unknown;
  }
  if (process.platform === 'darwin') {
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    const apps: string[] = [];
    for (const root of roots) {
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) if (entry.name.endsWith('.app')) apps.push(path.join(root, entry.name));
    }
    return query ? apps.filter((app) => app.toLowerCase().includes(query.toLowerCase())) : apps;
  }
  const roots = ['/usr/share/applications', '/usr/local/share/applications', path.join(os.homedir(), '.local/share/applications')];
  const apps: Array<{ name: string; path: string }> = [];
  for (const root of roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.desktop')) apps.push({ name: entry.name, path: path.join(root, entry.name) });
  }
  return query ? apps.filter((app) => app.name.toLowerCase().includes(query.toLowerCase())) : apps;
}

async function scheduledTasks(): Promise<unknown> {
  if (process.platform === 'win32') return JSON.parse((await ps('Get-ScheduledTask | Select TaskName,TaskPath,State,Author,Description | ConvertTo-Json -Compress')).stdout.trim() || '[]') as unknown;
  if (process.platform === 'darwin') return { launchctl: (await exec('launchctl', ['list'])).stdout, userLaunchAgents: await fs.readdir(path.join(os.homedir(), 'Library/LaunchAgents')).catch(() => []) };
  return { timers: (await exec('systemctl', ['list-timers', '--all', '--no-pager'])).stdout, userCrontab: (await exec('crontab', ['-l']).catch((error: unknown) => ({ stdout: '', stderr: String(error), command: 'crontab', args: [] }))).stdout };
}

async function taskManage(name: string, action: string, command?: string, schedule?: string): Promise<CommandResult> {
  if (process.platform === 'win32') {
    if (action === 'create') {
      if (!command) throw new Error('command is required for create.');
      const sc = schedule ?? 'ONLOGON';
      return exec('schtasks.exe', ['/Create', '/TN', name, '/TR', command, '/SC', sc, '/F']);
    }
    const map: Record<string, string> = { delete: '/Delete', run: '/Run', enable: '/Change', disable: '/Change' };
    const args = [map[action] ?? '', '/TN', name];
    if (action === 'delete') args.push('/F');
    if (action === 'enable') args.push('/ENABLE');
    if (action === 'disable') args.push('/DISABLE');
    return exec('schtasks.exe', args);
  }
  if (process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const domain = `gui/${uid}`;
    if (action === 'run') return exec('launchctl', ['kickstart', '-k', `${domain}/${name}`]);
    if (action === 'enable' || action === 'disable') return exec('launchctl', [action, `${domain}/${name}`]);
    if (action === 'delete') return exec('launchctl', ['bootout', `${domain}/${name}`]);
    throw new Error('On macOS create a LaunchAgent plist with filesystem_write, then use launchctl bootstrap via shell_exec.');
  }
  if (action === 'run') return exec('systemctl', ['--user', 'start', name]);
  if (action === 'enable' || action === 'disable') return exec('systemctl', ['--user', action, name]);
  if (action === 'delete') throw new Error('Delete the corresponding systemd unit or crontab entry with filesystem tools, then daemon-reload.');
  throw new Error('On Linux create a systemd user service/timer with filesystem_write, then enable it with service_control.');
}

async function firewallStatus(): Promise<unknown> {
  if (process.platform === 'win32') return JSON.parse((await ps('Get-NetFirewallProfile | Select Name,Enabled,DefaultInboundAction,DefaultOutboundAction,NotifyOnListen,LogFileName | ConvertTo-Json -Compress')).stdout.trim() || '[]') as unknown;
  if (process.platform === 'darwin') return { applicationFirewall: (await exec('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'])).stdout, pf: (await exec('pfctl', ['-s', 'info']).catch((error: unknown) => ({ stdout: '', stderr: String(error), command: 'pfctl', args: [] }))).stdout };
  if (await exists('ufw')) return { backend: 'ufw', raw: (await exec('ufw', ['status', 'verbose'])).stdout };
  if (await exists('firewall-cmd')) return { backend: 'firewalld', raw: (await exec('firewall-cmd', ['--list-all'])).stdout };
  if (await exists('nft')) return { backend: 'nftables', raw: (await exec('nft', ['list', 'ruleset'])).stdout };
  throw new Error('No supported firewall backend found.');
}

async function firewallRule(action: string, name: string, direction: string, protocol: string, port?: number, program?: string): Promise<CommandResult> {
  if (process.platform === 'win32') {
    if (action === 'delete') return ps(`Remove-NetFirewallRule -DisplayName ${psQuote(name)}`);
    const fields = [`-DisplayName ${psQuote(name)}`, `-Direction ${direction}`, `-Action Allow`, `-Protocol ${protocol}`];
    if (port !== undefined) fields.push(`-LocalPort ${port}`);
    if (program) fields.push(`-Program ${psQuote(program)}`);
    return ps(`New-NetFirewallRule ${fields.join(' ')}`);
  }
  if (process.platform === 'darwin') {
    if (!program) throw new Error('macOS application firewall rules require program path.');
    const flag = action === 'delete' ? '--remove' : '--add';
    return exec('/usr/libexec/ApplicationFirewall/socketfilterfw', [flag, program]);
  }
  if (!await exists('ufw')) throw new Error('Linux firewall_rule currently requires ufw.');
  const sudo = typeof process.getuid === 'function' && process.getuid() !== 0 ? ['sudo', ['-n', 'ufw']] as const : ['ufw', []] as const;
  const rule = port !== undefined ? `${port}/${protocol.toLowerCase()}` : program ?? name;
  return exec(sudo[0], [...sudo[1], action === 'delete' ? 'delete' : 'allow', ...(direction === 'outbound' ? ['out'] : ['in']), rule]);
}

async function systemLogs(query?: string, limit = 500, since?: string): Promise<unknown> {
  if (process.platform === 'win32') {
    const filter = query ? ` | Where-Object {$_.Message -like ${psQuote(`*${query}*`)} -or $_.ProviderName -like ${psQuote(`*${query}*`)}}` : '';
    const out = await ps(`Get-WinEvent -LogName System -MaxEvents ${limit}${filter} | Select TimeCreated,Id,LevelDisplayName,ProviderName,Message | ConvertTo-Json -Depth 3 -Compress`);
    return JSON.parse(out.stdout.trim() || '[]') as unknown;
  }
  if (process.platform === 'darwin') {
    const predicate = query ? ['--predicate', `eventMessage CONTAINS[c] ${JSON.stringify(query)}`] : [];
    return { raw: (await exec('log', ['show', '--style', 'json', '--last', since ?? '1h', ...predicate])).stdout.split(/\r?\n/).slice(0, limit) };
  }
  const args = ['--no-pager', '-n', String(limit), '-o', 'json'];
  if (since) args.push('--since', since);
  if (query) args.push('--grep', query);
  return { entries: (await exec('journalctl', args)).stdout.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown; } catch { return { raw: line }; } }) };
}

async function powerAction(action: string): Promise<CommandResult> {
  if (process.platform === 'win32') {
    if (action === 'lock') return exec('rundll32.exe', ['user32.dll,LockWorkStation']);
    if (action === 'sleep') return exec('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    if (action === 'logoff') return exec('shutdown.exe', ['/l']);
    return exec('shutdown.exe', [action === 'restart' ? '/r' : '/s', '/t', '0']);
  }
  if (process.platform === 'darwin') {
    if (action === 'lock') return exec('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']);
    if (action === 'sleep') return exec('pmset', ['sleepnow']);
    const event = action === 'restart' ? 'restart' : action === 'logoff' ? 'log out' : 'shut down';
    return exec('osascript', ['-e', `tell application "System Events" to ${event}`]);
  }
  const map: Record<string, string[]> = { lock: ['lock-session'], sleep: ['suspend'], restart: ['reboot'], shutdown: ['poweroff'], logoff: ['terminate-user', os.userInfo().username] };
  return exec('loginctl', map[action] ?? [action]);
}

export function registerAdminTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'privilege_status', { title: 'Privilege Status', description: 'Report whether the agent has administrator/root or passwordless sudo capability.', inputSchema: {}, annotations: { readOnlyHint: true } }, privilegeStatus);
  context.register(server, 'service_list', { title: 'List Services', description: 'List Windows services, launchd jobs, or systemd services.', inputSchema: { query: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ query }) => ({ services: await listServices(query) }));
  context.register(server, 'service_control', { title: 'Control Service', description: 'Start, stop, restart, enable or disable an OS service.', inputSchema: { name: z.string().min(1), action: z.enum(['start', 'stop', 'restart', 'enable', 'disable']), scope: z.enum(['system', 'user']).default('system') }, annotations: { readOnlyHint: false, destructiveHint: true } }, async ({ name, action, scope }) => { requireFull(context, 'service_control'); return serviceControl(name, action, scope); });
  context.register(server, 'package_manager_detect', { title: 'Detect Package Manager', description: 'Detect the preferred native package manager.', inputSchema: {}, annotations: { readOnlyHint: true } }, async () => ({ manager: await packageManager() }));
  context.register(server, 'package_manage', { title: 'Manage Packages', description: 'List, search, install, uninstall or update packages using winget, Homebrew or the native Linux package manager.', inputSchema: { operation: z.enum(['list', 'search', 'install', 'uninstall', 'update']), packages: z.array(z.string()).max(100).default([]), query: z.string().optional(), manager: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ operation, packages, query, manager }) => { if (['install', 'uninstall', 'update'].includes(operation)) requireFull(context, 'package mutation'); return packageCommand(manager ?? await packageManager(), operation, packages, query); });
  context.register(server, 'disk_info', { title: 'Disk Information', description: 'Return physical disk, partition, volume and filesystem information.', inputSchema: {}, annotations: { readOnlyHint: true } }, diskInfo);
  context.register(server, 'user_group_list', { title: 'List Users and Groups', description: 'List local operating-system users and groups.', inputSchema: {}, annotations: { readOnlyHint: true } }, userList);
  context.register(server, 'installed_applications', { title: 'List Installed Applications', description: 'Enumerate installed desktop applications and packages visible to the OS.', inputSchema: { query: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ query }) => ({ applications: await installedApplications(query) }));
  context.register(server, 'scheduled_task_list', { title: 'List Scheduled Tasks', description: 'List Windows Task Scheduler tasks, launchd jobs, systemd timers and user crontab.', inputSchema: {}, annotations: { readOnlyHint: true } }, scheduledTasks);
  context.register(server, 'scheduled_task_manage', { title: 'Manage Scheduled Task', description: 'Create, run, enable, disable or delete a scheduled task/job. Platform capabilities vary.', inputSchema: { name: z.string().min(1), action: z.enum(['create', 'run', 'enable', 'disable', 'delete']), command: z.string().optional(), schedule: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: true } }, async ({ name, action, command, schedule }) => { requireFull(context, 'scheduled_task_manage'); return taskManage(name, action, command, schedule); });
  context.register(server, 'firewall_status', { title: 'Firewall Status', description: 'Return native firewall profile and rule-engine status.', inputSchema: {}, annotations: { readOnlyHint: true } }, firewallStatus);
  context.register(server, 'firewall_rule', { title: 'Manage Firewall Rule', description: 'Add or delete a native firewall rule. Windows supports port/program rules; macOS supports application rules; Linux currently uses ufw.', inputSchema: { action: z.enum(['add', 'delete']), name: z.string().min(1), direction: z.enum(['inbound', 'outbound']).default('inbound'), protocol: z.enum(['TCP', 'UDP', 'Any']).default('TCP'), port: z.number().int().min(1).max(65535).optional(), program: z.string().optional() }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, async ({ action, name, direction, protocol, port, program }) => { requireFull(context, 'firewall_rule'); return firewallRule(action, name, direction, protocol, port, program); });
  context.register(server, 'system_logs', { title: 'Read System Logs', description: 'Read recent Windows Event Log, macOS unified log, or Linux journal entries.', inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(10_000).default(500), since: z.string().optional() }, annotations: { readOnlyHint: true } }, async ({ query, limit, since }) => systemLogs(query, limit, since));
  context.register(server, 'power_control', { title: 'Power and Session Control', description: 'Lock, sleep, log off, restart or shut down the machine.', inputSchema: { action: z.enum(['lock', 'sleep', 'logoff', 'restart', 'shutdown']) }, annotations: { readOnlyHint: false, destructiveHint: true } }, async ({ action }) => { requireFull(context, 'power_control'); return powerAction(action); });
}
