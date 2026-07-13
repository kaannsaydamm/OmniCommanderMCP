import { promises as fs } from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './types.js';
import {
  captureScreen,
  closeApplication,
  controlWindow,
  cursorPosition,
  defaultScreenshotPath,
  desktopCapabilities,
  executeComputerAction,
  keyboardHotkey,
  keyboardKey,
  keyboardType,
  launchApplication,
  listMonitors,
  listWindows,
  mouseClick,
  mouseDrag,
  mouseMove,
  mouseScroll,
  type ComputerAction,
  type ScreenRegion
} from '../platform/desktop.js';
import { accessibilitySnapshot, findOcrMatches, ocrText, ocrWords, windowsElementInvoke } from '../platform/accessibility.js';

const regionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
});

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait'), durationMs: z.number().int().min(0).max(120_000) }),
  z.object({ type: z.literal('mouse_move'), x: z.number().int(), y: z.number().int(), durationMs: z.number().int().min(0).max(30_000).optional() }),
  z.object({ type: z.literal('mouse_click'), button: z.enum(['left', 'middle', 'right']).optional(), x: z.number().int().optional(), y: z.number().int().optional(), clicks: z.number().int().min(1).max(10).optional() }),
  z.object({ type: z.literal('mouse_drag'), fromX: z.number().int(), fromY: z.number().int(), toX: z.number().int(), toY: z.number().int(), durationMs: z.number().int().min(0).max(30_000).optional(), button: z.enum(['left', 'middle', 'right']).optional() }),
  z.object({ type: z.literal('mouse_scroll'), deltaX: z.number().int().optional(), deltaY: z.number().int() }),
  z.object({ type: z.literal('keyboard_type'), text: z.string(), intervalMs: z.number().int().min(0).max(5_000).optional() }),
  z.object({ type: z.literal('keyboard_key'), key: z.string().min(1) }),
  z.object({ type: z.literal('keyboard_hotkey'), keys: z.array(z.string().min(1)).min(1).max(8) }),
  z.object({ type: z.literal('window_control'), target: z.string().min(1), action: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize']), x: z.number().int().optional(), y: z.number().int().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional() }),
  z.object({ type: z.literal('application_launch'), target: z.string().min(1), args: z.array(z.string()).max(100).optional() }),
  z.object({ type: z.literal('application_close'), target: z.string().min(1), force: z.boolean().optional() })
]);

async function screenshotResult(context: ToolContext, outputPath?: string, region?: ScreenRegion, includeBase64 = false) {
  const requested = outputPath ?? defaultScreenshotPath();
  const target = await context.policy.assertPath(requested, 'desktop screenshot output');
  await captureScreen(target, region);
  const stat = await fs.stat(target);
  const output: Record<string, unknown> = { path: target, mimeType: 'image/png', size: stat.size };
  if (includeBase64) {
    if (stat.size > context.config.get().maxReadBytes) throw new Error(`Screenshot exceeds maxReadBytes (${context.config.get().maxReadBytes}).`);
    output.base64 = (await fs.readFile(target)).toString('base64');
  }
  return output;
}

async function screenshotMcpContent(context: ToolContext, outputPath?: string, region?: ScreenRegion) {
  const requested = outputPath ?? defaultScreenshotPath();
  const target = await context.policy.assertPath(requested, 'desktop screenshot output');
  await captureScreen(target, region);
  const data = await fs.readFile(target);
  return {
    content: [
      { type: 'image' as const, data: data.toString('base64'), mimeType: 'image/png' },
      { type: 'text' as const, text: JSON.stringify({ path: target, bytes: data.length }) }
    ]
  };
}

export function registerDesktopTools(server: McpServer, context: ToolContext): void {
  context.register(server, 'desktop_capabilities', {
    title: 'Desktop Capabilities',
    description: 'Detect computer-use backends, display server, required permissions and optional OS utilities.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => desktopCapabilities());

  context.register(server, 'monitor_list', {
    title: 'List Monitors',
    description: 'Return connected monitor/display information using the native platform backend.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => listMonitors());

  context.register(server, 'window_list', {
    title: 'List Desktop Windows',
    description: 'Enumerate visible desktop windows with identifiers, titles, process IDs and geometry where supported.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => ({ windows: await listWindows() }));

  context.register(server, 'window_control', {
    title: 'Control Desktop Window',
    description: 'Focus, minimize, maximize, restore, close, move or resize a desktop window by ID, title or application.',
    inputSchema: {
      target: z.string().min(1),
      action: z.enum(['focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize']),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ target, action, x, y, width, height }) => {
    const geometry: Partial<ScreenRegion> = {};
    if (x !== undefined) geometry.x = x;
    if (y !== undefined) geometry.y = y;
    if (width !== undefined) geometry.width = width;
    if (height !== undefined) geometry.height = height;
    await controlWindow(target, action, geometry);
    return { target, action, ok: true };
  });

  context.register(server, 'application_launch', {
    title: 'Launch Application',
    description: 'Launch an application or executable with arguments and return a PID when the platform exposes one.',
    inputSchema: { target: z.string().min(1), args: z.array(z.string()).max(100).default([]) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ target, args }) => ({ target, ...(await launchApplication(target, args)) }));

  context.register(server, 'application_close', {
    title: 'Close Application',
    description: 'Request an application to quit, or force terminate it when force=true.',
    inputSchema: { target: z.string().min(1), force: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ target, force }) => {
    await closeApplication(target, force);
    return { target, force, closed: true };
  });

  context.register(server, 'desktop_screenshot_file', {
    title: 'Capture Desktop to File',
    description: 'Capture the virtual desktop or a rectangular region to a PNG file. Optionally include base64 in the JSON result.',
    inputSchema: { outputPath: z.string().optional(), region: regionSchema.optional(), includeBase64: z.boolean().default(false) },
    annotations: { readOnlyHint: true }
  }, async ({ outputPath, region, includeBase64 }) => screenshotResult(context, outputPath, region, includeBase64));

  context.registerRaw(server, 'computer_observe', {
    title: 'Observe Computer Screen',
    description: 'Capture the virtual desktop or a region and return a directly viewable PNG image for vision-based computer use.',
    inputSchema: { outputPath: z.string().optional(), region: regionSchema.optional() },
    annotations: { readOnlyHint: true }
  }, async ({ outputPath, region }) => screenshotMcpContent(context, outputPath, region));


  context.register(server, 'accessibility_snapshot', {
    title: 'Accessibility Tree Snapshot',
    description: 'Return semantic UI elements from the focused application using Windows UI Automation, macOS Accessibility, or Linux AT-SPI.',
    inputSchema: { maxDepth: z.number().int().min(1).max(20).default(6), maxNodes: z.number().int().min(1).max(20_000).default(2_000) },
    annotations: { readOnlyHint: true }
  }, async ({ maxDepth, maxNodes }) => accessibilitySnapshot(maxDepth, maxNodes));

  context.register(server, 'accessibility_invoke', {
    title: 'Invoke Accessibility Element',
    description: 'Invoke or select a semantic UI element by accessible name or automation ID. Currently implemented through Windows UI Automation.',
    inputSchema: { target: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ target }) => windowsElementInvoke(target));

  context.register(server, 'screen_ocr', {
    title: 'OCR Screen or Image',
    description: 'Run local Tesseract OCR over an existing image or a fresh desktop screenshot. Can return plain text or word bounding boxes.',
    inputSchema: {
      imagePath: z.string().optional(),
      outputPath: z.string().optional(),
      region: regionSchema.optional(),
      language: z.string().default('eng'),
      mode: z.enum(['text', 'words']).default('words'),
      minConfidence: z.number().min(-1).max(100).default(30)
    },
    annotations: { readOnlyHint: true }
  }, async ({ imagePath, outputPath, region, language, mode, minConfidence }) => {
    let source: string;
    if (imagePath) source = await context.policy.assertPath(imagePath, 'OCR input');
    else {
      source = await context.policy.assertPath(outputPath ?? defaultScreenshotPath(), 'OCR screenshot output');
      await captureScreen(source, region);
    }
    if (mode === 'text') return { imagePath: source, language, text: await ocrText(source, language) };
    const words = await ocrWords(source, language, minConfidence);
    return { imagePath: source, language, words, count: words.length };
  });

  context.register(server, 'screen_find_text', {
    title: 'Find Text on Screen',
    description: 'Capture the screen, OCR it, and return coordinates for words matching a text query.',
    inputSchema: {
      query: z.string().min(1),
      exact: z.boolean().default(false),
      language: z.string().default('eng'),
      minConfidence: z.number().min(-1).max(100).default(30),
      region: regionSchema.optional(),
      outputPath: z.string().optional()
    },
    annotations: { readOnlyHint: true }
  }, async ({ query, exact, language, minConfidence, region, outputPath }) => {
    const source = await context.policy.assertPath(outputPath ?? defaultScreenshotPath(), 'OCR screenshot output');
    await captureScreen(source, region);
    const words = await ocrWords(source, language, minConfidence);
    const matches = findOcrMatches(words, query, exact).map((match) => ({
      ...match,
      centerX: match.centerX + (region?.x ?? 0),
      centerY: match.centerY + (region?.y ?? 0)
    }));
    return { imagePath: source, query, matches, count: matches.length };
  });

  context.registerRaw(server, 'computer_click_text', {
    title: 'Click Text on Screen',
    description: 'Capture and OCR the screen, click the selected matching text, then return a fresh screenshot. Useful for autonomous UI operation without hard-coded coordinates.',
    inputSchema: {
      query: z.string().min(1),
      occurrence: z.number().int().min(0).default(0),
      exact: z.boolean().default(false),
      language: z.string().default('eng'),
      minConfidence: z.number().min(-1).max(100).default(30),
      region: regionSchema.optional(),
      button: z.enum(['left', 'middle', 'right']).default('left'),
      settleMs: z.number().int().min(0).max(30_000).default(500)
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ query, occurrence, exact, language, minConfidence, region, button, settleMs }) => {
    const beforePath = await context.policy.assertPath(defaultScreenshotPath(), 'OCR screenshot output');
    await captureScreen(beforePath, region);
    const words = await ocrWords(beforePath, language, minConfidence);
    const matches = findOcrMatches(words, query, exact);
    const match = matches[occurrence];
    if (!match) throw new Error(`No OCR match found for ${JSON.stringify(query)} at occurrence ${occurrence}. Found ${matches.length}.`);
    const x = match.centerX + (region?.x ?? 0);
    const y = match.centerY + (region?.y ?? 0);
    await mouseClick(button, x, y, 1);
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const afterPath = await context.policy.assertPath(defaultScreenshotPath(), 'desktop screenshot output');
    await captureScreen(afterPath);
    const data = await fs.readFile(afterPath);
    return { content: [
      { type: 'image' as const, data: data.toString('base64'), mimeType: 'image/png' },
      { type: 'text' as const, text: JSON.stringify({ clicked: { query, occurrence, x, y, match }, beforePath, afterPath }, null, 2) }
    ] };
  });

  context.register(server, 'cursor_position', {
    title: 'Get Cursor Position',
    description: 'Return the current absolute mouse cursor coordinates.',
    inputSchema: {},
    annotations: { readOnlyHint: true }
  }, async () => cursorPosition());

  context.register(server, 'mouse_move', {
    title: 'Move Mouse',
    description: 'Move the mouse to absolute screen coordinates, optionally interpolating over a duration.',
    inputSchema: { x: z.number().int(), y: z.number().int(), durationMs: z.number().int().min(0).max(30_000).default(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ x, y, durationMs }) => {
    await mouseMove(x, y, durationMs);
    return { x, y };
  });

  context.register(server, 'mouse_click', {
    title: 'Click Mouse',
    description: 'Click a mouse button at the current pointer or supplied coordinates. Supports repeated clicks.',
    inputSchema: { button: z.enum(['left', 'middle', 'right']).default('left'), x: z.number().int().optional(), y: z.number().int().optional(), clicks: z.number().int().min(1).max(10).default(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ button, x, y, clicks }) => {
    await mouseClick(button, x, y, clicks);
    return { button, x, y, clicks };
  });

  context.register(server, 'mouse_drag', {
    title: 'Drag Mouse',
    description: 'Drag from one absolute screen coordinate to another using a selected mouse button.',
    inputSchema: { fromX: z.number().int(), fromY: z.number().int(), toX: z.number().int(), toY: z.number().int(), durationMs: z.number().int().min(0).max(30_000).default(500), button: z.enum(['left', 'middle', 'right']).default('left') },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ fromX, fromY, toX, toY, durationMs, button }) => {
    await mouseDrag(fromX, fromY, toX, toY, durationMs, button);
    return { fromX, fromY, toX, toY, durationMs, button };
  });

  context.register(server, 'mouse_scroll', {
    title: 'Scroll Mouse',
    description: 'Send vertical and optional horizontal wheel deltas to the focused application.',
    inputSchema: { deltaY: z.number().int(), deltaX: z.number().int().default(0) },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ deltaY, deltaX }) => {
    await mouseScroll(deltaY, deltaX);
    return { deltaY, deltaX };
  });

  context.register(server, 'keyboard_type', {
    title: 'Type Text',
    description: 'Type text into the focused application with an optional interval between characters.',
    inputSchema: { text: z.string(), intervalMs: z.number().int().min(0).max(5_000).default(0) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ text, intervalMs }) => {
    await keyboardType(text, intervalMs);
    return { characters: text.length, intervalMs };
  });

  context.register(server, 'keyboard_key', {
    title: 'Press Keyboard Key',
    description: 'Press one named key such as enter, tab, escape, left, delete, F5 or a literal character.',
    inputSchema: { key: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ key }) => {
    await keyboardKey(key);
    return { key };
  });

  context.register(server, 'keyboard_hotkey', {
    title: 'Send Keyboard Shortcut',
    description: 'Send a multi-key shortcut such as ["ctrl","shift","p"] or ["command","space"].',
    inputSchema: { keys: z.array(z.string().min(1)).min(1).max(8) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ keys }) => {
    await keyboardHotkey(keys);
    return { keys };
  });

  context.register(server, 'computer_sequence', {
    title: 'Execute Computer-Use Sequence',
    description: 'Execute an ordered sequence of mouse, keyboard, window, application and wait actions. Use computer_observe before and after uncertain UI interactions.',
    inputSchema: {
      actions: z.array(actionSchema).min(1).max(100),
      stopOnError: z.boolean().default(true),
      delayBetweenMs: z.number().int().min(0).max(10_000).default(0)
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ actions, stopOnError, delayBetweenMs }) => {
    const results: Record<string, unknown>[] = [];
    for (const [index, action] of (actions as ComputerAction[]).entries()) {
      try {
        results.push({ index, ...(await executeComputerAction(action)) });
      } catch (error) {
        const failure = { index, action: action.type, ok: false, error: error instanceof Error ? error.message : String(error) };
        results.push(failure);
        if (stopOnError) break;
      }
      if (delayBetweenMs > 0) await new Promise((resolve) => setTimeout(resolve, delayBetweenMs));
    }
    return { requested: actions.length, completed: results.length, results };
  });

  context.registerRaw(server, 'computer_act_and_observe', {
    title: 'Act and Observe Computer',
    description: 'Execute one computer-use action and immediately return a fresh screenshot for the next autonomous reasoning step.',
    inputSchema: { action: actionSchema, outputPath: z.string().optional(), region: regionSchema.optional(), settleMs: z.number().int().min(0).max(30_000).default(500) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  }, async ({ action, outputPath, region, settleMs }) => {
    const actionResult = await executeComputerAction(action as ComputerAction);
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const requested = outputPath ?? defaultScreenshotPath();
    const target = await context.policy.assertPath(requested, 'desktop screenshot output');
    await captureScreen(target, region);
    const data = await fs.readFile(target);
    return {
      content: [
        { type: 'image' as const, data: data.toString('base64'), mimeType: 'image/png' },
        { type: 'text' as const, text: JSON.stringify({ actionResult, screenshot: { path: target, bytes: data.length } }, null, 2) }
      ]
    };
  });
}
