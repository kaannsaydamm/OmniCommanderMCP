# Omni Commander MCP

**Omni Commander MCP** is a cross-platform, local-first MCP agent that gives an authorized AI client broad control over a Windows, macOS, or Linux computer.

It combines two control planes in one auditable server:

1. **System/CLI control:** files, shell, persistent terminals, processes, services, packages, network requests, firewall, scheduled tasks, Git, archives, disks, users, logs, clipboard, and power/session operations.
2. **Computer use:** screenshots returned as MCP images, monitor/window/application control, mouse, keyboard, accessibility-tree inspection, local OCR, text-coordinate discovery, and observe-act-observe loops.

The server can run locally over stdio, over an authenticated loopback/private Streamable HTTP endpoint, or privately from **ChatGPT web through OpenAI Secure MCP Tunnel** without opening inbound firewall ports.

> This project intentionally has powerful tools. `--profile=full` is equivalent to granting the connected MCP client an interactive desktop and terminal under the OS account that launches Omni Commander. Read [SECURITY.md](SECURITY.md).

## Current status

Version **0.2.0** exposes **80 MCP tools** and includes:

- Windows, macOS, and Linux adapters.
- MCP stdio and Streamable HTTP transports.
- OpenAI Secure MCP Tunnel setup scripts.
- Persistent process sessions with stdin and paginated output.
- Direct image-returning screen observation.
- Multi-step autonomous computer-use sequences.
- OCR-based `find text` and `click text` workflows.
- Windows UI Automation, macOS Accessibility, and Linux AT-SPI discovery adapters.
- Safe/full policy profiles, SSRF controls, path canonicalization, and JSONL audit logs.
- Cross-platform CI, type checking, integration tests, and production builds.

## Tool catalog

| Area | Tools |
|---|---|
| Configuration | `config_get`, `config_set` |
| Filesystem/search | `fs_read`, `fs_read_many`, `fs_write`, `fs_patch`, `fs_list`, `fs_mkdir`, `fs_copy`, `fs_move`, `fs_delete`, `fs_stat`, `fs_hash`, `fs_search` |
| Terminal/processes | `shell_exec`, `process_start`, `process_output`, `process_input`, `process_terminate`, `process_sessions`, `process_list`, `process_kill` |
| Computer observation | `desktop_capabilities`, `monitor_list`, `desktop_screenshot`, `desktop_screenshot_file`, `computer_observe`, `screen_ocr`, `screen_find_text`, `accessibility_snapshot` |
| Computer actions | `mouse_move`, `mouse_click`, `mouse_drag`, `mouse_scroll`, `cursor_position`, `keyboard_type`, `keyboard_key`, `keyboard_hotkey`, `computer_sequence`, `computer_act_and_observe`, `computer_click_text`, `accessibility_invoke` |
| Apps/windows | `application_launch`, `application_close`, `window_list`, `window_control`, `desktop_open` |
| OS administration | `privilege_status`, `service_list`, `service_control`, `package_manager_detect`, `package_manage`, `disk_info`, `user_group_list`, `installed_applications`, `scheduled_task_list`, `scheduled_task_manage`, `firewall_status`, `firewall_rule`, `system_logs`, `power_control` |
| System/clipboard/env | `system_info`, `env_get`, `env_set`, `clipboard_read`, `clipboard_write` |
| Network | `http_request`, `http_download` |
| Git | `git_status`, `git_diff`, `git_log`, `git_stage`, `git_commit`, `git_branch`, `git_checkout`, `git_remote_sync`, `git_clone` |
| Archives | `archive_list`, `archive_create`, `archive_extract` |

Anything not represented by a structured tool can still be performed through `shell_exec` or a persistent `process_start` session when the launching OS account has permission.

## Install

Requirements:

- Node.js 20 or later.
- Git.
- Optional desktop/OCR dependencies listed below.

```bash
git clone https://github.com/kaannsaydamm/OmniCommanderMCP.git
cd OmniCommanderMCP
npm ci
npm run check
npm run build
```

Install optional computer-use dependencies:

```bash
# macOS or Linux
./scripts/install-desktop-deps.sh
```

```powershell
# Windows; built-in APIs cover core computer use.
# Add -InstallTesseract for OCR.
./scripts/install-desktop-deps.ps1 -InstallTesseract
```

## Run locally

Safe profile:

```bash
node dist/index.js --profile=safe
```

Full profile:

```bash
node dist/index.js --profile=full
```

MCP client example:

```json
{
  "mcpServers": {
    "omni-commander": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/OmniCommanderMCP/dist/index.js",
        "--profile=full"
      ],
      "env": {
        "OMNI_AUDIT_ENABLED": "true"
      }
    }
  }
}
```

## Connect ChatGPT web to your computer

The recommended remote path is **OpenAI Secure MCP Tunnel**. `tunnel-client` runs on your computer, starts Omni Commander over stdio, and makes only outbound HTTPS connections to OpenAI. The MCP server does not need a public listener.

### 1. Build Omni Commander

```bash
npm ci
npm run build
```

### 2. Create an MCP tunnel

Create a tunnel in OpenAI Platform tunnel settings and obtain:

- A `tunnel_id`.
- A runtime API key for `tunnel-client`.
- Tunnels **Read + Use** permission; tunnel creation/editing additionally needs **Manage**.

Download the current `tunnel-client` from the OpenAI Platform tunnel page or the official `openai/tunnel-client` releases.

### 3. Configure the local tunnel profile

macOS/Linux:

```bash
CONTROL_PLANE_API_KEY="sk-..." ./scripts/setup-openai-tunnel.sh tunnel_0123456789abcdef0123456789abcdef
```

Windows PowerShell:

```powershell
$env:CONTROL_PLANE_API_KEY = "sk-..."
./scripts/setup-openai-tunnel.ps1 -TunnelId "tunnel_0123456789abcdef0123456789abcdef" -SecurityProfile full
```

The scripts configure this local MCP command:

```text
node /absolute/path/OmniCommanderMCP/dist/index.js --profile=full
```

### 4. Run the tunnel

```bash
tunnel-client doctor --profile omni-commander --explain
tunnel-client run --profile omni-commander
```

Keep it running while ChatGPT uses the computer. The tunnel client exposes loopback health/readiness/metrics endpoints and a local `/ui` operator page.

### 5. Add it in ChatGPT

Enable ChatGPT developer mode, open **Settings → Plugins**, create a developer-mode app, select **Tunnel** as the connection, and choose the tunnel. The tunnel must be associated with the target ChatGPT workspace.

See [docs/REMOTE_CHATGPT.md](docs/REMOTE_CHATGPT.md) for startup-service templates and troubleshooting.

## Streamable HTTP mode

Stdio + Secure MCP Tunnel is preferred for ChatGPT. For local/private integrations, Omni Commander can also expose MCP over Streamable HTTP:

```bash
node dist/index.js --http --host=127.0.0.1 --port=8787 --profile=full
```

Endpoint:

```text
http://127.0.0.1:8787/mcp
```

Health endpoints:

```text
/healthz
/readyz
```

Binding outside loopback requires a bearer token:

```bash
OMNI_HTTP_TOKEN="a-long-random-secret" \
node dist/index.js --http --host=0.0.0.0 --port=8787 --allowed-hosts=omni.internal.example --profile=full
```

This fixed bearer mode is for controlled private deployments. A public internet deployment should use a proper OAuth authorization server, TLS, strict host validation, and an external reverse proxy. Do not expose full-profile Omni Commander anonymously.

## Autonomous computer-use pattern

A reliable loop is:

1. `computer_observe` to receive a fresh screenshot.
2. `accessibility_snapshot` or `screen_find_text` when semantic targeting is possible.
3. `computer_act_and_observe` for one action plus a fresh screenshot.
4. Repeat until the task is verified complete.

For deterministic multi-step operations, use `computer_sequence`. For visible text, `computer_click_text` captures, OCRs, clicks the chosen occurrence, and returns the post-click screen.

See [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md).

## Platform support

### Windows

- Built-in PowerShell, .NET, Win32, Windows UI Automation, service, registry/task/firewall tooling.
- Run Omni Commander at the same elevation level as applications it must control.
- A non-elevated process cannot reliably manipulate elevated windows because of Windows integrity levels.
- Tesseract is optional for OCR.

### macOS

- `screencapture`, AppleScript/System Events, `open`, `launchctl`, and optional `cliclick`.
- Grant **Accessibility** permission for keyboard/window control.
- Grant **Screen Recording** permission for screenshots.
- Install optional dependencies with Homebrew.

### Linux

- X11: `xdotool`, `wmctrl`, `xrandr`, screenshot and clipboard utilities.
- Wayland: screenshots can use `grim`; input control depends on compositor security and available tools.
- Accessibility uses Python AT-SPI (`pyatspi`).
- Headless service sessions cannot control a graphical desktop unless attached to the active user session and display bus.

## Security profiles

### `safe` (default)

- Filesystem paths restricted to configured roots.
- Common catastrophic shell patterns blocked.
- Private and loopback HTTP targets blocked.
- Environment values hidden.
- Lower output and file-size limits.
- Audit logging enabled.

### `full`

- All filesystem paths allowed by the OS account.
- No Omni Commander command-pattern blocklist.
- Private/loopback network and environment access enabled.
- OS administration mutation tools enabled.
- Higher finite I/O limits.

`full` does not bypass ACLs, UAC, sudo, TCC, endpoint security, sandboxing, display-server boundaries, or application permissions.

## Configuration

Precedence:

```text
profile defaults < config JSON < environment < CLI < config_set
```

Default configuration:

```text
~/.omni-commander/config.json
```

Default audit log:

```text
~/.omni-commander/audit.jsonl
```

Important environment variables are documented in [.env.example](.env.example).

## Development and validation

```bash
npm run typecheck
npm test
npm run build
```

The integration test connects an MCP client through an in-memory transport and verifies that the complete terminal, desktop, accessibility, network, developer, and OS-admin tool surface is discoverable.

CI executes typecheck, tests, and build on Windows, macOS, and Ubuntu with Node.js 20 and 22.

## Architecture and roadmap

- [Architecture](docs/ARCHITECTURE.md)
- [Computer use](docs/COMPUTER_USE.md)
- [ChatGPT remote connection](docs/REMOTE_CHATGPT.md)
- [Roadmap](docs/ROADMAP.md)
- [Security policy](SECURITY.md)

## License

MIT
