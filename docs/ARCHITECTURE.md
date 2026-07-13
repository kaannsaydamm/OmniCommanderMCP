# Architecture

## Runtime topology

```text
Local MCP client ─────────────── stdio ──────────────┐
                                                     │
ChatGPT/Codex/API ─ OpenAI Secure MCP Tunnel ────────┤
                                                     ▼
Private client ─ authenticated Streamable HTTP ─ McpServer
                                                     │
                                  ToolContext + audit wrapper
                                                     │
                          ┌──────────────────────────┼────────────────────────┐
                          ▼                          ▼                        ▼
                    PolicyEngine              SessionManager           SearchManager
                          │                          │                        │
       ┌──────────────────┼──────────────────────────┼────────────────────────┤
       ▼                  ▼                          ▼                        ▼
 Files/network     OS administration        CLI/process sessions      computer use
 Git/archives      services/packages        stdin/output buffers      vision/UI/OCR
```

`WatchManager` sits beside the process and search managers. It owns native watcher handles, assigns monotonically increasing event cursors, bounds retained events by `maxWatchEvents`, and closes handles on explicit stop, transport shutdown, or stale-session cleanup.

## Transport modes

### Stdio

The default and smallest attack surface. Secure MCP Tunnel can launch this command locally, keeping the server private.

### Streamable HTTP

Optional stateful MCP sessions at `/mcp`, with `/healthz` and `/readyz`. Loopback is the default. Non-loopback binds require a bearer token and should remain inside a controlled private network or behind a proper OAuth/TLS gateway.

## Registration pipeline

Every tool is registered through `ToolContext`:

1. Execute handler.
2. Normalize errors into MCP error results.
3. Measure duration.
4. Redact and append a JSONL audit record.
5. Serialize structured results, or preserve raw image content for computer observation.

## Policy profiles

`safe` applies allowed-root checks, command pattern blocks, SSRF/private-address controls, hidden environment values, and lower limits.

`full` removes application-level command/path/private-network restrictions and enables destructive OS administration tools. Native OS permissions still govern execution.

## Computer-use adapters

- Windows: PowerShell + .NET + Win32 + UI Automation.
- macOS: `screencapture`, AppleScript/System Events, `cliclick`, Accessibility.
- Linux: X11/Wayland command backends, AT-SPI, Tesseract.

Adapters report capabilities instead of pretending unsupported operations succeeded.

## Process sessions

Each managed process stores UUID, PID, command, working directory, timestamps, state, exit code/signal, bounded output, and an absolute read offset. Clients can interact with REPLs and long-running commands through stdin and paginated output.

## File-watch sessions

Each watch session stores UUID, canonical policy-approved root, recursive flag, timestamps, state, a native watcher handle, and a bounded cursor-addressed event buffer. Reads use an exclusive cursor and report both retention truncation and whether another page is available. Native watcher errors become retained error events and terminal session state.

## Remote trust boundary

With Secure MCP Tunnel:

- `tunnel-client` authenticates outbound to OpenAI.
- MCP requests are forwarded to local stdio or private HTTP.
- Omni Commander remains inside the user's environment.
- The audit layer records tool calls after they reach the server.
- ChatGPT workspace/tunnel permissions control which OpenAI context can discover the tunnel.
