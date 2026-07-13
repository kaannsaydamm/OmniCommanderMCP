import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandExists } from './desktop.js';

const execFileAsync = promisify(execFile);

export interface OcrWord {
  level: number;
  page: number;
  block: number;
  paragraph: number;
  line: number;
  word: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  text: string;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function powershell(script: string): Promise<string> {
  const executable = process.env.OMNI_POWERSHELL || 'powershell.exe';
  const { stdout } = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', script], {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  });
  return stdout;
}

export async function accessibilitySnapshot(maxDepth = 6, maxNodes = 2_000): Promise<unknown> {
  const depth = Math.max(1, Math.min(20, maxDepth));
  const limit = Math.max(1, Math.min(20_000, maxNodes));

  if (process.platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName UIAutomationClient',
      'Add-Type -AssemblyName UIAutomationTypes',
      `$maxDepth=${depth};$maxNodes=${limit}`,
      '$root=[System.Windows.Automation.AutomationElement]::FocusedElement',
      'if($null -eq $root){$root=[System.Windows.Automation.AutomationElement]::RootElement}',
      '$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker',
      '$items=New-Object System.Collections.Generic.List[object]',
      'function Walk($node,$d){',
      ' if($null -eq $node -or $d -gt $maxDepth -or $items.Count -ge $maxNodes){return}',
      ' try{$r=$node.Current.BoundingRectangle;$items.Add([pscustomobject]@{depth=$d;name=$node.Current.Name;automationId=$node.Current.AutomationId;controlType=$node.Current.ControlType.ProgrammaticName;className=$node.Current.ClassName;enabled=$node.Current.IsEnabled;offscreen=$node.Current.IsOffscreen;focusable=$node.Current.IsKeyboardFocusable;x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height})}catch{}',
      ' $child=$walker.GetFirstChild($node)',
      ' while($null -ne $child -and $items.Count -lt $maxNodes){Walk $child ($d+1);$child=$walker.GetNextSibling($child)}',
      '}',
      'Walk $root 0',
      '$items|ConvertTo-Json -Depth 4 -Compress'
    ].join('; ');
    const stdout = (await powershell(script)).trim();
    if (!stdout) return { platform: 'win32', nodes: [], truncated: false };
    const parsed = JSON.parse(stdout) as unknown;
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    return { platform: 'win32', root: 'focused-element', nodes, count: nodes.length, truncated: nodes.length >= limit };
  }

  if (process.platform === 'darwin') {
    const script = [
      'tell application "System Events"',
      'set frontProc to first application process whose frontmost is true',
      'set appName to name of frontProc',
      'set rows to {}',
      'try',
      `set allElements to entire contents of front window of frontProc`,
      `set nodeLimit to ${limit}`,
      'repeat with e in allElements',
      'if (count rows) ≥ nodeLimit then exit repeat',
      'try',
      'set roleValue to role of e as text',
      'set descValue to description of e as text',
      'set titleValue to ""',
      'try',
      'set titleValue to value of attribute "AXTitle" of e as text',
      'end try',
      'set posValue to position of e',
      'set sizeValue to size of e',
      'set end of rows to appName & tab & roleValue & tab & descValue & tab & titleValue & tab & (item 1 of posValue as text) & tab & (item 2 of posValue as text) & tab & (item 1 of sizeValue as text) & tab & (item 2 of sizeValue as text)',
      'end try',
      'end repeat',
      'end try',
      'return rows as text',
      'end tell'
    ].join('\n');
    const { stdout } = await execFileAsync('osascript', ['-e', script], { maxBuffer: 32 * 1024 * 1024 });
    const raw = stdout.trim();
    const nodes = raw ? raw.split(', ').map((row) => {
      const [application = '', role = '', description = '', title = '', x = '0', y = '0', width = '0', height = '0'] = row.split('\t');
      return { application, role, description, title, x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
    }) : [];
    return { platform: 'darwin', nodes, count: nodes.length, truncated: nodes.length >= limit };
  }

  if (await commandExists('python3')) {
    const code = String.raw`
import json
try:
 import pyatspi
except Exception as e:
 print(json.dumps({"error":"pyatspi is not installed", "detail":str(e)})); raise SystemExit(0)
limit=${limit}
max_depth=${depth}
items=[]
def walk(node,d=0):
 if len(items)>=limit or d>max_depth: return
 try:
  ext=node.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
  item={"depth":d,"name":node.name,"role":node.getRoleName(),"description":node.description,"x":ext.x,"y":ext.y,"width":ext.width,"height":ext.height,"states":[str(s) for s in node.getState().getStates()]}
  items.append(item)
 except Exception:
  pass
 try:
  for child in node:
   walk(child,d+1)
 except Exception:
  pass
for desktop in pyatspi.Registry.getDesktop(0):
 try:
  if desktop.getState().contains(pyatspi.STATE_ACTIVE) or desktop.getState().contains(pyatspi.STATE_FOCUSED): walk(desktop,0)
 except Exception: pass
 if len(items)>=limit: break
print(json.dumps({"platform":"linux","nodes":items,"count":len(items),"truncated":len(items)>=limit}))
`;
    const { stdout } = await execFileAsync('python3', ['-c', code], { maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout.trim() || '{}') as unknown;
  }

  throw new Error('Accessibility snapshot requires python3 and pyatspi on Linux. Install python3-pyatspi/at-spi2-core.');
}

export async function ocrWords(imagePath: string, language = 'eng', minConfidence = 0): Promise<OcrWord[]> {
  if (!await commandExists('tesseract')) throw new Error('Tesseract OCR is required. Install tesseract (and the requested language pack).');
  const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '-l', language, 'tsv'], { maxBuffer: 64 * 1024 * 1024 });
  const lines = stdout.split(/\r?\n/);
  const rows: OcrWord[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const columns = line.split('\t');
    if (columns.length < 12) continue;
    const confidence = Number(columns[10]);
    const text = columns.slice(11).join('\t').trim();
    if (!text || !Number.isFinite(confidence) || confidence < minConfidence) continue;
    rows.push({
      level: Number(columns[0]), page: Number(columns[1]), block: Number(columns[2]), paragraph: Number(columns[3]), line: Number(columns[4]), word: Number(columns[5]),
      x: Number(columns[6]), y: Number(columns[7]), width: Number(columns[8]), height: Number(columns[9]), confidence, text
    });
  }
  return rows;
}

export async function ocrText(imagePath: string, language = 'eng'): Promise<string> {
  if (!await commandExists('tesseract')) throw new Error('Tesseract OCR is required. Install tesseract (and the requested language pack).');
  const { stdout } = await execFileAsync('tesseract', [imagePath, 'stdout', '-l', language], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

export function findOcrMatches(words: OcrWord[], query: string, exact = false): Array<OcrWord & { centerX: number; centerY: number }> {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return words.filter((word) => {
    const candidate = word.text.toLocaleLowerCase();
    return exact ? candidate === needle : candidate.includes(needle);
  }).map((word) => ({ ...word, centerX: Math.round(word.x + word.width / 2), centerY: Math.round(word.y + word.height / 2) }));
}

export async function windowsElementInvoke(nameOrAutomationId: string): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('UI Automation invoke is currently Windows-only.');
  const target = psQuote(nameOrAutomationId);
  const script = [
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    `$target=${target}`,
    '$root=[System.Windows.Automation.AutomationElement]::RootElement',
    '$nameCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$target)',
    '$idCond=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$target)',
    '$cond=New-Object System.Windows.Automation.OrCondition($nameCond,$idCond)',
    '$el=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cond)',
    'if($null -eq $el){throw "Element not found: $target"}',
    '$pattern=$null',
    'if($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){([System.Windows.Automation.InvokePattern]$pattern).Invoke();[pscustomobject]@{invoked=$true;name=$el.Current.Name;automationId=$el.Current.AutomationId}|ConvertTo-Json -Compress}',
    'elseif($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){([System.Windows.Automation.SelectionItemPattern]$pattern).Select();[pscustomobject]@{selected=$true;name=$el.Current.Name;automationId=$el.Current.AutomationId}|ConvertTo-Json -Compress}',
    'else{throw "Element has no Invoke or SelectionItem pattern"}'
  ].join('; ');
  const stdout = (await powershell(script)).trim();
  return JSON.parse(stdout || '{}') as unknown;
}
