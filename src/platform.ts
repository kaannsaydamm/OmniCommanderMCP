import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { platform, homedir, hostname, arch, release } from 'node:os';
import { readFile, writeFile, readdir, stat, mkdir, rm, rename, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);
export const os = platform();

export async function shell(command: string, cwd?: string, timeoutMs = 120000) {
  const executable = os === 'win32' ? 'powershell.exe' : '/bin/sh';
  const args = os === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command];
  const { stdout, stderr } = await execFileAsync(executable, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { stdout, stderr };
}

export function spawnProcess(command: string, args: string[] = [], cwd?: string) {
  const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { pid: child.pid };
}

export const systemInfo = () => ({ os, arch: arch(), release: release(), hostname: hostname(), home: homedir(), node: process.version });
export const fsOps = {
  readText: (path: string) => readFile(resolve(path), 'utf8'),
  writeText: async (path: string, content: string) => { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(resolve(path), content, 'utf8'); return true; },
  list: async (path: string) => Promise.all((await readdir(resolve(path))).map(async name => ({ name, ...(await stat(resolve(path, name))) }))),
  mkdir: (path: string) => mkdir(resolve(path), { recursive: true }),
  remove: (path: string, recursive = false) => rm(resolve(path), { recursive, force: true }),
  move: (from: string, to: string) => rename(resolve(from), resolve(to)),
  copy: (from: string, to: string) => copyFile(resolve(from), resolve(to))
};

function ps(script: string) { return shell(script); }
function osa(script: string) { return execFileAsync('osascript', ['-e', script], { maxBuffer: 8 * 1024 * 1024 }); }

export async function launchApp(target: string, args: string[] = []) {
  if (os === 'win32') return ps(`Start-Process -FilePath ${JSON.stringify(target)} -ArgumentList ${JSON.stringify(args.join(' '))}`);
  if (os === 'darwin') return execFileAsync('open', ['-a', target, '--args', ...args]);
  return spawnProcess(target, args);
}
export async function closeApp(name: string) {
  if (os === 'win32') return ps(`Get-Process -Name ${JSON.stringify(name)} -ErrorAction SilentlyContinue | Stop-Process -Force`);
  if (os === 'darwin') return osa(`tell application ${JSON.stringify(name)} to quit`);
  return shell(`pkill -f -- ${JSON.stringify(name)}`);
}
export async function screenshot(path: string) {
  const out = resolve(path);
  if (os === 'win32') await ps(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save(${JSON.stringify(out)},[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $i.Dispose()`);
  else if (os === 'darwin') await execFileAsync('screencapture', ['-x', out]);
  else await shell(`(command -v gnome-screenshot >/dev/null && gnome-screenshot -f ${JSON.stringify(out)}) || (command -v import >/dev/null && import -window root ${JSON.stringify(out)})`);
  return out;
}
export async function mouseMove(x: number, y: number) {
  if (os === 'win32') return ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`);
  if (os === 'darwin') return shell(`cliclick m:${x},${y}`);
  return shell(`xdotool mousemove ${x} ${y}`);
}
export async function mouseClick(button = 'left', x?: number, y?: number) {
  if (x !== undefined && y !== undefined) await mouseMove(x, y);
  const map: Record<string, number> = { left: 1, middle: 2, right: 3 };
  if (os === 'win32') return ps(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class M { [DllImport("user32.dll")] public static extern void mouse_event(int a,int b,int c,int d,int e); }'; [M]::mouse_event(${button === 'right' ? 8 : 2},0,0,0,0); [M]::mouse_event(${button === 'right' ? 16 : 4},0,0,0,0)`);
  if (os === 'darwin') return shell(`cliclick ${button === 'right' ? 'rc' : 'c'}:.`);
  return shell(`xdotool click ${map[button] ?? 1}`);
}
export async function typeText(text: string) {
  if (os === 'win32') return ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(text.replace(/[+^%~(){}\[\]]/g, '{$&}'))})`);
  if (os === 'darwin') return osa(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
  return shell(`xdotool type --delay 1 -- ${JSON.stringify(text)}`);
}
export async function hotkey(keys: string[]) {
  const joined = keys.join('+');
  if (os === 'win32') return ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(joined)})`);
  if (os === 'darwin') return shell(`cliclick kd:${keys.join(',')} ku:${keys.reverse().join(',')}`);
  return shell(`xdotool key ${JSON.stringify(joined)}`);
}
export async function clipboardGet() {
  if (os === 'win32') return (await ps('Get-Clipboard -Raw')).stdout;
  if (os === 'darwin') return (await execFileAsync('pbpaste')).stdout;
  return (await shell('(command -v wl-paste >/dev/null && wl-paste) || xclip -selection clipboard -o')).stdout;
}
export async function clipboardSet(text: string) {
  if (os === 'win32') return ps(`Set-Clipboard -Value ${JSON.stringify(text)}`);
  if (os === 'darwin') return shell(`printf %s ${JSON.stringify(text)} | pbcopy`);
  return shell(`printf %s ${JSON.stringify(text)} | ((command -v wl-copy >/dev/null && wl-copy) || xclip -selection clipboard)`);
}
