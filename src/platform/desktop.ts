import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type MouseButton = 'left' | 'middle' | 'right';
export type WindowAction = 'focus' | 'minimize' | 'maximize' | 'restore' | 'close' | 'move' | 'resize';

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ComputerAction =
  | { type: 'wait'; durationMs: number }
  | { type: 'mouse_move'; x: number; y: number; durationMs?: number }
  | { type: 'mouse_click'; button?: MouseButton; x?: number; y?: number; clicks?: number }
  | { type: 'mouse_drag'; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number; button?: MouseButton }
  | { type: 'mouse_scroll'; deltaX?: number; deltaY: number }
  | { type: 'keyboard_type'; text: string; intervalMs?: number }
  | { type: 'keyboard_key'; key: string }
  | { type: 'keyboard_hotkey'; keys: string[] }
  | { type: 'window_control'; target: string; action: WindowAction; x?: number; y?: number; width?: number; height?: number }
  | { type: 'application_launch'; target: string; args?: string[] }
  | { type: 'application_close'; target: string; force?: boolean };

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function run(command: string, args: string[] = [], maxBuffer = 16 * 1024 * 1024): Promise<ExecResult> {
  const result = await execFileAsync(command, args, { windowsHide: true, maxBuffer });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function powershell(script: string): Promise<ExecResult> {
  const executable = process.env.OMNI_POWERSHELL || 'powershell.exe';
  return run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', script]);
}

async function appleScript(script: string): Promise<ExecResult> {
  return run('osascript', ['-e', script]);
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    await run(process.platform === 'win32' ? 'where.exe' : 'which', [command], 1024 * 1024);
    return true;
  } catch {
    return false;
  }
}

function parseJsonOutput<T>(stdout: string, fallback: T): T {
  const trimmed = stdout.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed) as T;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function requirePositiveRegion(region: ScreenRegion): void {
  if (region.width <= 0 || region.height <= 0) throw new Error('Screenshot region width and height must be positive.');
}

export async function desktopCapabilities(): Promise<Record<string, unknown>> {
  const commands = process.platform === 'darwin'
    ? ['osascript', 'screencapture', 'cliclick']
    : process.platform === 'linux'
      ? ['xdotool', 'wmctrl', 'xrandr', 'wlr-randr', 'grim', 'gnome-screenshot', 'scrot', 'wl-copy', 'wl-paste', 'xclip']
      : ['powershell.exe'];
  const availability = Object.fromEntries(await Promise.all(commands.map(async (command) => [command, await commandExists(command)])));
  return {
    platform: process.platform,
    displayServer: process.env.XDG_SESSION_TYPE || (process.env.WAYLAND_DISPLAY ? 'wayland' : process.env.DISPLAY ? 'x11' : undefined),
    commands: availability,
    notes: process.platform === 'darwin'
      ? ['Grant Accessibility permission for keyboard/window control and Screen Recording permission for screenshots.', 'Install cliclick for pointer automation: brew install cliclick.']
      : process.platform === 'linux'
        ? ['X11 automation uses xdotool/wmctrl. Wayland support depends on compositor tools such as grim and ydotool.', 'Clipboard uses wl-clipboard on Wayland or xclip on X11.']
        : ['Some elevated applications cannot be controlled from a non-elevated agent due to Windows integrity levels.', 'Screen capture and input run in the interactive user session.']
  };
}

export async function listMonitors(): Promise<unknown> {
  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {',
      '  [pscustomobject]@{ deviceName=$_.DeviceName; primary=$_.Primary; x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height; workingX=$_.WorkingArea.X; workingY=$_.WorkingArea.Y; workingWidth=$_.WorkingArea.Width; workingHeight=$_.WorkingArea.Height }',
      '} | ConvertTo-Json -Compress'
    ].join('\n');
    return parseJsonOutput((await powershell(script)).stdout, []);
  }
  if (process.platform === 'darwin') {
    const output = await run('system_profiler', ['SPDisplaysDataType', '-json']);
    return parseJsonOutput(output.stdout, {});
  }
  if (await commandExists('wlr-randr')) return { backend: 'wlr-randr', raw: (await run('wlr-randr')).stdout };
  if (await commandExists('xrandr')) return { backend: 'xrandr', raw: (await run('xrandr', ['--query'])).stdout };
  throw new Error('No monitor backend found (wlr-randr or xrandr).');
}

export async function captureScreen(outputPath: string, region?: ScreenRegion): Promise<string> {
  const target = path.resolve(outputPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (region) requirePositiveRegion(region);

  if (process.platform === 'win32') {
    const boundsScript = region
      ? `$x=${region.x}; $y=${region.y}; $w=${region.width}; $h=${region.height}`
      : 'Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $x=$b.X; $y=$b.Y; $w=$b.Width; $h=$b.Height';
    const script = [
      'Add-Type -AssemblyName System.Drawing',
      boundsScript,
      '$bmp=New-Object System.Drawing.Bitmap $w,$h',
      '$g=[System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($x,$y,0,0,$bmp.Size)',
      `$bmp.Save(${quotePowerShell(target)},[System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose(); $bmp.Dispose()'
    ].join('; ');
    await powershell(script);
    return target;
  }

  if (process.platform === 'darwin') {
    const args = ['-x'];
    if (region) args.push('-R', `${region.x},${region.y},${region.width},${region.height}`);
    args.push(target);
    await run('screencapture', args);
    return target;
  }

  if (await commandExists('grim')) {
    const args = region ? ['-g', `${region.x},${region.y} ${region.width}x${region.height}`, target] : [target];
    await run('grim', args);
    return target;
  }
  if (!region && await commandExists('gnome-screenshot')) {
    await run('gnome-screenshot', ['-f', target]);
    return target;
  }
  if (!region && await commandExists('scrot')) {
    await run('scrot', [target]);
    return target;
  }
  if (region && await commandExists('import')) {
    await run('import', ['-window', 'root', '-crop', `${region.width}x${region.height}+${region.x}+${region.y}`, target]);
    return target;
  }
  throw new Error('No compatible screenshot backend found. Install grim, gnome-screenshot, scrot, or ImageMagick.');
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  if (process.platform === 'win32') {
    const script = 'Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; [pscustomobject]@{x=$p.X;y=$p.Y}|ConvertTo-Json -Compress';
    return parseJsonOutput((await powershell(script)).stdout, { x: 0, y: 0 });
  }
  if (process.platform === 'darwin') {
    if (!await commandExists('cliclick')) throw new Error('cliclick is required on macOS. Install with: brew install cliclick');
    const output = (await run('cliclick', ['p:.'])).stdout.trim();
    const match = output.match(/(-?\d+),(-?\d+)/);
    if (!match) throw new Error(`Unable to parse cliclick cursor output: ${output}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for cursor position on Linux/X11.');
  const output = (await run('xdotool', ['getmouselocation', '--shell'])).stdout;
  const values = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => line.split('=')));
  return { x: Number(values.X), y: Number(values.Y) };
}

export async function mouseMove(x: number, y: number, durationMs = 0): Promise<void> {
  if (durationMs > 0) {
    const start = await cursorPosition();
    const steps = Math.max(2, Math.min(120, Math.ceil(durationMs / 16)));
    for (let index = 1; index <= steps; index += 1) {
      const ratio = index / steps;
      await mouseMove(Math.round(start.x + (x - start.x) * ratio), Math.round(start.y + (y - start.y) * ratio), 0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.floor(durationMs / steps))));
    }
    return;
  }
  if (process.platform === 'win32') {
    await powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`);
    return;
  }
  if (process.platform === 'darwin') {
    if (!await commandExists('cliclick')) throw new Error('cliclick is required on macOS. Install with: brew install cliclick');
    await run('cliclick', [`m:${x},${y}`]);
    return;
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for mouse control on Linux/X11.');
  await run('xdotool', ['mousemove', '--sync', String(x), String(y)]);
}

const winMouseFlags: Record<MouseButton, [number, number]> = {
  left: [0x0002, 0x0004],
  right: [0x0008, 0x0010],
  middle: [0x0020, 0x0040]
};

export async function mouseClick(button: MouseButton = 'left', x?: number, y?: number, clicks = 1): Promise<void> {
  if ((x === undefined) !== (y === undefined)) throw new Error('Provide both x and y, or neither.');
  if (x !== undefined && y !== undefined) await mouseMove(x, y);
  const count = Math.max(1, Math.min(10, clicks));
  if (process.platform === 'win32') {
    const [down, up] = winMouseFlags[button];
    const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OmniMouse{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);}'; 1..${count}|%{[OmniMouse]::mouse_event(${down},0,0,0,[UIntPtr]::Zero);[OmniMouse]::mouse_event(${up},0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 70}`;
    await powershell(script);
    return;
  }
  if (process.platform === 'darwin') {
    if (!await commandExists('cliclick')) throw new Error('cliclick is required on macOS. Install with: brew install cliclick');
    const action = button === 'right' ? 'rc:.' : button === 'middle' ? 'tc:.' : count === 2 ? 'dc:.' : 'c:.';
    const actions = count > 2 ? Array.from({ length: count }, () => action).join(' ') : action;
    await run('cliclick', actions.split(' '));
    return;
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for mouse control on Linux/X11.');
  const buttonNumber = button === 'left' ? '1' : button === 'middle' ? '2' : '3';
  await run('xdotool', ['click', '--repeat', String(count), '--delay', '70', buttonNumber]);
}

export async function mouseDrag(fromX: number, fromY: number, toX: number, toY: number, durationMs = 500, button: MouseButton = 'left'): Promise<void> {
  await mouseMove(fromX, fromY);
  if (process.platform === 'win32') {
    const [down, up] = winMouseFlags[button];
    await powershell(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OmniMouse{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);}';[OmniMouse]::mouse_event(${down},0,0,0,[UIntPtr]::Zero)`);
    await mouseMove(toX, toY, durationMs);
    await powershell(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OmniMouse{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);}';[OmniMouse]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`);
    return;
  }
  if (process.platform === 'darwin') {
    if (!await commandExists('cliclick')) throw new Error('cliclick is required on macOS. Install with: brew install cliclick');
    await run('cliclick', [`dd:${fromX},${fromY}`, `du:${toX},${toY}`]);
    return;
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for mouse control on Linux/X11.');
  const buttonNumber = button === 'left' ? '1' : button === 'middle' ? '2' : '3';
  await run('xdotool', ['mousedown', buttonNumber]);
  await mouseMove(toX, toY, durationMs);
  await run('xdotool', ['mouseup', buttonNumber]);
}

export async function mouseScroll(deltaY: number, deltaX = 0): Promise<void> {
  if (process.platform === 'win32') {
    const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class OmniMouse{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,int d,UIntPtr e);}';[OmniMouse]::mouse_event(2048,0,0,${Math.trunc(deltaY)},[UIntPtr]::Zero);[OmniMouse]::mouse_event(4096,0,0,${Math.trunc(deltaX)},[UIntPtr]::Zero)`;
    await powershell(script);
    return;
  }
  if (process.platform === 'darwin') {
    if (!await commandExists('cliclick')) throw new Error('cliclick is required on macOS. Install with: brew install cliclick');
    await run('cliclick', [`w:${Math.trunc(deltaY / 10) || Math.sign(deltaY)}`]);
    return;
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for mouse control on Linux/X11.');
  const verticalButton = deltaY > 0 ? '4' : '5';
  const horizontalButton = deltaX > 0 ? '6' : '7';
  if (deltaY !== 0) await run('xdotool', ['click', '--repeat', String(Math.max(1, Math.abs(Math.trunc(deltaY / 120)) || 1)), verticalButton]);
  if (deltaX !== 0) await run('xdotool', ['click', '--repeat', String(Math.max(1, Math.abs(Math.trunc(deltaX / 120)) || 1)), horizontalButton]);
}

function windowsSendKeysKey(key: string): string {
  const aliases: Record<string, string> = {
    enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
    home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', space: ' '
  };
  const normalized = key.toLowerCase();
  if (aliases[normalized]) return aliases[normalized];
  if (/^f([1-9]|1[0-2])$/.test(normalized)) return `{${normalized.toUpperCase()}}`;
  if (key.length === 1) return key.replace(/[+^%~(){}[\]]/g, '{$&}');
  throw new Error(`Unsupported Windows key name: ${key}`);
}

function xdotoolKey(key: string): string {
  const aliases: Record<string, string> = { ctrl: 'ctrl', control: 'ctrl', cmd: 'super', command: 'super', meta: 'super', win: 'super', option: 'alt', escape: 'Escape', enter: 'Return', return: 'Return', pageup: 'Page_Up', pagedown: 'Page_Down', space: 'space' };
  return aliases[key.toLowerCase()] ?? key;
}

function macKeyCode(key: string): string | undefined {
  const map: Record<string, string> = { enter: '36', return: '36', tab: '48', space: '49', backspace: '51', escape: '53', left: '123', right: '124', down: '125', up: '126', delete: '117', home: '115', end: '119', pageup: '116', pagedown: '121' };
  return map[key.toLowerCase()];
}

export async function keyboardType(text: string, intervalMs = 0): Promise<void> {
  if (process.platform === 'win32') {
    if (intervalMs <= 0) {
      const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}');
      await powershell(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${quotePowerShell(escaped)})`);
      return;
    }
    for (const character of text) {
      await keyboardType(character, 0);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return;
  }
  if (process.platform === 'darwin') {
    await appleScript(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
    return;
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for keyboard control on Linux/X11.');
  await run('xdotool', ['type', '--clearmodifiers', '--delay', String(Math.max(0, intervalMs)), '--', text]);
}

export async function keyboardKey(key: string): Promise<void> {
  if (process.platform === 'win32') {
    await powershell(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${quotePowerShell(windowsSendKeysKey(key))})`);
    return;
  }
  if (process.platform === 'darwin') {
    const code = macKeyCode(key);
    if (code) await appleScript(`tell application "System Events" to key code ${code}`);
    else if (key.length === 1) await appleScript(`tell application "System Events" to keystroke ${JSON.stringify(key)}`);
    else throw new Error(`Unsupported macOS key name: ${key}`);
    return;
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for keyboard control on Linux/X11.');
  await run('xdotool', ['key', '--clearmodifiers', xdotoolKey(key)]);
}

export async function keyboardHotkey(keys: string[]): Promise<void> {
  if (keys.length === 0) throw new Error('At least one key is required.');
  if (process.platform === 'win32') {
    const modifiers: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+', win: '^{ESC}', meta: '^{ESC}', command: '^{ESC}' };
    const last = keys[keys.length - 1] ?? '';
    const prefix = keys.slice(0, -1).map((key) => modifiers[key.toLowerCase()] ?? '').join('');
    await powershell(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${quotePowerShell(prefix + windowsSendKeysKey(last))})`);
    return;
  }
  if (process.platform === 'darwin') {
    const modifierMap: Record<string, string> = { ctrl: 'control down', control: 'control down', alt: 'option down', option: 'option down', shift: 'shift down', cmd: 'command down', command: 'command down', meta: 'command down' };
    const last = keys[keys.length - 1] ?? '';
    const modifiers = keys.slice(0, -1).map((key) => modifierMap[key.toLowerCase()]).filter(Boolean);
    const using = modifiers.length ? ` using {${modifiers.join(', ')}}` : '';
    const code = macKeyCode(last);
    const command = code ? `key code ${code}${using}` : `keystroke ${JSON.stringify(last)}${using}`;
    await appleScript(`tell application "System Events" to ${command}`);
    return;
  }
  if (!await commandExists('xdotool')) throw new Error('xdotool is required for keyboard control on Linux/X11.');
  await run('xdotool', ['key', '--clearmodifiers', keys.map(xdotoolKey).join('+')]);
}

export async function listWindows(): Promise<unknown[]> {
  if (process.platform === 'win32') {
    const script = [
      `Add-Type -TypeDefinition @'\nusing System;using System.Text;using System.Runtime.InteropServices;using System.Collections.Generic;public class OmniWin{public delegate bool D(IntPtr h,IntPtr l);[DllImport("user32.dll")]public static extern bool EnumWindows(D d,IntPtr l);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);public struct R{public int Left,Top,Right,Bottom;}}\n'@`,
      '$items=New-Object System.Collections.Generic.List[object]',
      '[OmniWin]::EnumWindows({param($h,$l) if([OmniWin]::IsWindowVisible($h)){ $s=New-Object Text.StringBuilder 2048;[void][OmniWin]::GetWindowText($h,$s,$s.Capacity);if($s.Length -gt 0){$r=New-Object OmniWin+R;$p=0;[void][OmniWin]::GetWindowRect($h,[ref]$r);[void][OmniWin]::GetWindowThreadProcessId($h,[ref]$p);$items.Add([pscustomobject]@{id=$h.ToInt64().ToString();pid=$p;title=$s.ToString();x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top})}} return $true},[IntPtr]::Zero)|Out-Null',
      '$items|ConvertTo-Json -Compress'
    ].join('; ');
    const parsed = parseJsonOutput<unknown | unknown[]>((await powershell(script)).stdout, []);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  if (process.platform === 'darwin') {
    const script = `tell application "System Events"\nset rows to {}\nrepeat with p in (application processes whose background only is false)\nrepeat with w in windows of p\ntry\nset end of rows to (name of p as text) & tab & (name of w as text) & tab & (item 1 of position of w as text) & tab & (item 2 of position of w as text) & tab & (item 1 of size of w as text) & tab & (item 2 of size of w as text)\nend try\nend repeat\nend repeat\nreturn rows as text\nend tell`;
    const output = (await appleScript(script)).stdout.trim();
    if (!output) return [];
    return output.split(', ').map((line, index) => {
      const [application = '', title = '', x = '0', y = '0', width = '0', height = '0'] = line.split('\t');
      return { id: `${application}:${index}`, application, title, x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
    });
  }
  if (!await commandExists('wmctrl')) throw new Error('wmctrl is required for window enumeration on Linux/X11.');
  const output = (await run('wmctrl', ['-lpGx'])).stdout.trim();
  if (!output) return [];
  return output.split(/\r?\n/).map((line) => {
    const parts = line.trim().split(/\s+/);
    const [id = '', desktop = '', pid = '', x = '', y = '', width = '', height = '', windowClass = '', host = '', ...titleParts] = parts;
    return { id, desktop: Number(desktop), pid: Number(pid), x: Number(x), y: Number(y), width: Number(width), height: Number(height), windowClass, host, title: titleParts.join(' ') };
  });
}

export async function controlWindow(target: string, action: WindowAction, geometry: Partial<ScreenRegion> = {}): Promise<void> {
  if (process.platform === 'win32') {
    const targetLiteral = quotePowerShell(target);
    const script = [
      `Add-Type -TypeDefinition @'\nusing System;using System.Text;using System.Runtime.InteropServices;public class OmniW{public delegate bool D(IntPtr h,IntPtr l);[DllImport("user32.dll")]public static extern bool EnumWindows(D d,IntPtr l);[DllImport("user32.dll",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int z,bool r);[DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);}\n'@`,
      `$target=${targetLiteral};$found=[IntPtr]::Zero`,
      '[OmniW]::EnumWindows({param($h,$l)$s=New-Object Text.StringBuilder 2048;[void][OmniW]::GetWindowText($h,$s,$s.Capacity);if($h.ToInt64().ToString() -eq $target -or $s.ToString().IndexOf($target,[StringComparison]::OrdinalIgnoreCase) -ge 0){$script:found=$h;return $false};return $true},[IntPtr]::Zero)|Out-Null',
      'if($found -eq [IntPtr]::Zero){throw "Window not found: $target"}',
      action === 'focus' ? '[void][OmniW]::ShowWindow($found,9);[void][OmniW]::SetForegroundWindow($found)' :
        action === 'minimize' ? '[void][OmniW]::ShowWindow($found,6)' :
          action === 'maximize' ? '[void][OmniW]::ShowWindow($found,3)' :
            action === 'restore' ? '[void][OmniW]::ShowWindow($found,9)' :
              action === 'close' ? '[void][OmniW]::PostMessage($found,16,[IntPtr]::Zero,[IntPtr]::Zero)' :
                `[void][OmniW]::MoveWindow($found,${geometry.x ?? 0},${geometry.y ?? 0},${geometry.width ?? 800},${geometry.height ?? 600},$true)`
    ].join('; ');
    await powershell(script);
    return;
  }
  if (process.platform === 'darwin') {
    const app = target.split(':')[0] || target;
    if (action === 'focus') await appleScript(`tell application ${JSON.stringify(app)} to activate`);
    else if (action === 'close') await appleScript(`tell application "System Events" to tell process ${JSON.stringify(app)} to click button 1 of front window`);
    else if (action === 'minimize') await appleScript(`tell application "System Events" to tell process ${JSON.stringify(app)} to set value of attribute "AXMinimized" of front window to true`);
    else if (action === 'restore') await appleScript(`tell application "System Events" to tell process ${JSON.stringify(app)} to set value of attribute "AXMinimized" of front window to false`);
    else if (action === 'move') await appleScript(`tell application "System Events" to tell process ${JSON.stringify(app)} to set position of front window to {${geometry.x ?? 0},${geometry.y ?? 0}}`);
    else if (action === 'resize') await appleScript(`tell application "System Events" to tell process ${JSON.stringify(app)} to set size of front window to {${geometry.width ?? 800},${geometry.height ?? 600}}`);
    else if (action === 'maximize') await appleScript(`tell application "System Events" to tell process ${JSON.stringify(app)} to set value of attribute "AXFullScreen" of front window to true`);
    return;
  }
  if (!await commandExists('wmctrl')) throw new Error('wmctrl is required for window control on Linux/X11.');
  const byId = target.startsWith('0x');
  const selector = byId ? ['-i'] : [];
  if (action === 'focus') await run('wmctrl', [...selector, '-a', target]);
  else if (action === 'close') await run('wmctrl', [...selector, '-c', target]);
  else if (action === 'minimize') {
    if (!await commandExists('xdotool')) throw new Error('xdotool is required to minimize windows on Linux/X11.');
    await run('xdotool', ['windowminimize', target]);
  } else if (action === 'maximize') await run('wmctrl', [...selector, '-r', target, '-b', 'add,maximized_vert,maximized_horz']);
  else if (action === 'restore') await run('wmctrl', [...selector, '-r', target, '-b', 'remove,maximized_vert,maximized_horz,hidden']);
  else await run('wmctrl', [...selector, '-r', target, '-e', `0,${geometry.x ?? -1},${geometry.y ?? -1},${geometry.width ?? -1},${geometry.height ?? -1}`]);
}

export async function launchApplication(target: string, args: string[] = []): Promise<{ pid?: number }> {
  if (process.platform === 'win32') {
    const argumentList = args.length ? ` -ArgumentList @(${args.map(quotePowerShell).join(',')})` : '';
    const output = await powershell(`$p=Start-Process -FilePath ${quotePowerShell(target)}${argumentList} -PassThru;[pscustomobject]@{pid=$p.Id}|ConvertTo-Json -Compress`);
    return parseJsonOutput(output.stdout, {});
  }
  if (process.platform === 'darwin') {
    await run('open', ['-a', target, '--args', ...args]);
    return {};
  }
  const child = spawn(target, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid === undefined ? {} : { pid: child.pid };
}

export async function closeApplication(target: string, force = false): Promise<void> {
  if (process.platform === 'win32') {
    await powershell(`Get-Process -Name ${quotePowerShell(target.replace(/\.exe$/i, ''))} -ErrorAction SilentlyContinue | Stop-Process${force ? ' -Force' : ''}`);
    return;
  }
  if (process.platform === 'darwin') {
    if (force) await run('pkill', ['-9', '-x', target]);
    else await appleScript(`tell application ${JSON.stringify(target)} to quit`);
    return;
  }
  await run('pkill', [...(force ? ['-9'] : []), '-f', target]);
}

export async function executeComputerAction(action: ComputerAction): Promise<Record<string, unknown>> {
  switch (action.type) {
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(120_000, action.durationMs))));
      break;
    case 'mouse_move':
      await mouseMove(action.x, action.y, action.durationMs ?? 0);
      break;
    case 'mouse_click':
      await mouseClick(action.button ?? 'left', action.x, action.y, action.clicks ?? 1);
      break;
    case 'mouse_drag':
      await mouseDrag(action.fromX, action.fromY, action.toX, action.toY, action.durationMs ?? 500, action.button ?? 'left');
      break;
    case 'mouse_scroll':
      await mouseScroll(action.deltaY, action.deltaX ?? 0);
      break;
    case 'keyboard_type':
      await keyboardType(action.text, action.intervalMs ?? 0);
      break;
    case 'keyboard_key':
      await keyboardKey(action.key);
      break;
    case 'keyboard_hotkey':
      await keyboardHotkey(action.keys);
      break;
    case 'window_control': {
      const options: Partial<ScreenRegion> = {};
      if (action.x !== undefined) options.x = action.x;
      if (action.y !== undefined) options.y = action.y;
      if (action.width !== undefined) options.width = action.width;
      if (action.height !== undefined) options.height = action.height;
      await controlWindow(action.target, action.action, options);
      break;
    }
    case 'application_launch':
      return { action: action.type, ...(await launchApplication(action.target, action.args ?? [])) };
    case 'application_close':
      await closeApplication(action.target, action.force ?? false);
      break;
  }
  return { action: action.type, ok: true };
}

export function defaultScreenshotPath(): string {
  return path.join(os.tmpdir(), `omni-observe-${Date.now()}-${process.pid}.png`);
}
