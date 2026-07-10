# Omni Commander MCP

Omni Commander is a local-first, cross-platform MCP agent for terminal, filesystem, process, application, window, desktop and operating-system control.

## Install the current 0.2 source

The complete, locally validated 0.2.0 source tree is stored as a checksum-protected source archive so the repository remains installable even while GitHub-hosted runners are unavailable for this repository.

```bash
git clone https://github.com/kaannsaydamm/OmniCommanderMCP.git
cd OmniCommanderMCP
npm run materialize
npm install
npm run check
npm run build
```

`npm run materialize`:

1. Concatenates the seven files under `.omni/`.
2. Verifies the exact encoded size, archive size and SHA-256 digest.
3. Extracts the complete 0.2.0 source tree into the repository.
4. Verifies the resulting package version.

The expected archive SHA-256 is:

```text
a15ba5bd2ca3e39449f9f1e984694ab4bdb2b825f4b296f618ecf97d2bdef9ff
```

## Control surfaces

- Local MCP over stdio.
- Authenticated Streamable HTTP.
- OpenAI Secure MCP Tunnel for ChatGPT web without opening inbound ports.
- Filesystem read/write/edit/search operations.
- Interactive and one-shot shell/process sessions.
- Application launch/close and window management.
- Screenshot observation, mouse, keyboard, clipboard and multi-step computer-use actions.
- OCR text discovery and click-by-text.
- Windows UI Automation, macOS Accessibility and Linux AT-SPI integration points.
- Services, packages, disks, users, groups, scheduled tasks, firewall, logs and power operations.
- Network diagnostics and HTTP requests.
- Git and archive operations.
- Safe and full security profiles with JSONL audit logging.

## Tool surface

The 0.2.0 source registers 80 MCP tools, including:

- `shell_exec`, `process_start`, `process_input`, `process_output`, `process_terminate`
- `fs_read`, `fs_write`, `fs_patch`, `fs_search`, `fs_copy`, `fs_move`, `fs_delete`
- `computer_observe`, `computer_sequence`, `computer_act_and_observe`, `computer_click_text`
- `desktop_screenshot`, `screen_ocr`, `screen_find_text`, `accessibility_snapshot`, `accessibility_invoke`
- `mouse_move`, `mouse_click`, `mouse_drag`, `mouse_scroll`
- `keyboard_type`, `keyboard_key`, `keyboard_hotkey`, `clipboard_read`, `clipboard_write`
- `application_launch`, `application_close`, `window_list`, `window_control`
- `service_control`, `package_manage`, `scheduled_task_manage`, `firewall_rule`, `power_control`
- `http_request`, `http_download`, Git tools and archive tools

## Security profiles

The default `safe` profile limits filesystem roots, blocks known destructive command patterns, restricts private-network HTTP targets and redacts sensitive audit fields.

The explicitly selected `full` profile removes those policy restrictions and runs with the operating-system rights of the local agent process. It does not bypass OS permissions, elevation boundaries, UAC, SIP, sandboxing or endpoint-security controls.

## Validation status

A clean bootstrap was independently executed in an empty temporary directory. It passed:

- Archive size and SHA-256 validation
- `npm install`
- TypeScript type checking
- 6/6 automated tests
- Production build

The code has not yet been exercised on the user's actual Windows desktop because the connected Desktop Commander device is offline. Secure MCP Tunnel activation also requires the user's own OpenAI control-plane access and local tunnel-client authentication.
