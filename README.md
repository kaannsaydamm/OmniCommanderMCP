# OmniCommanderMCP

Cross-platform MCP agent for **full local computer control** from MCP clients such as ChatGPT, Claude Desktop, Codex, IDE agents, and custom orchestrators.

## Current scope

- Windows, macOS, and Linux adapters
- Arbitrary PowerShell / shell command execution
- Detached processes and application launch/close
- Full-path file read/write/list/copy/move/delete
- Process and service management
- Network inspection
- Native package managers (`winget`, `brew`, `apt`, `dnf`, `pacman`)
- Windows Registry access
- Screen capture returned as MCP image content
- Mouse movement and click
- Keyboard typing and hotkeys
- Clipboard read/write

The MCP process has the same permissions as the OS account that launches it. Running it elevated gives elevated access.

## Install

```bash
npm install
npm run build
npm start
```

Node.js 20+ is required.

## Local MCP configuration

```json
{
  "mcpServers": {
    "omni-commander": {
      "command": "node",
      "args": ["/absolute/path/OmniCommanderMCP/dist/index.js"]
    }
  }
}
```

## ChatGPT web / remote control architecture

OmniCommander is deliberately local-first. The recommended remote topology is:

```text
ChatGPT web / remote MCP client
            |
      authenticated tunnel
            |
OmniCommander agent on your PC
            |
 terminal + filesystem + OS + computer-use adapters
```

Do **not** expose an unauthenticated local MCP endpoint directly to the internet. Use an authenticated MCP tunnel or a private overlay network. A Streamable HTTP gateway, pairing flow, device identity, scoped tokens, audit log, and approval profiles are planned in the remote-agent milestone.

## Tool categories

### Terminal and OS
`run_command`, `spawn_process`, `list_processes`, `kill_process`, `list_services`, `service_control`, `network_info`, `package_manager`, `windows_registry`, `system_info`

### Filesystem
`read_file`, `write_file`, `list_directory`, `create_directory`, `delete_path`, `move_path`, `copy_file`

### Applications and computer use
`launch_application`, `close_application`, `capture_screen`, `capture_screen_image`, `mouse_move`, `mouse_click`, `keyboard_type`, `keyboard_hotkey`, `clipboard_get`, `clipboard_set`

## Platform prerequisites for computer use

Windows uses built-in PowerShell and .NET APIs.

macOS currently expects `cliclick` for pointer actions:

```bash
brew install cliclick
```

Grant Accessibility and Screen Recording permissions to Terminal/Node.

Linux currently uses `xdotool` and either `gnome-screenshot` or ImageMagick `import`. Wayland environments may require `ydotool`, `wtype`, or desktop-portal adapters in a later milestone.

## Security profiles

The current alpha exposes the host account's permissions. Before remote exposure, use a dedicated OS account or VM. Planned profiles:

- `observe`: screenshots and read-only inspection
- `safe`: normal file/application operations with destructive actions restricted
- `developer`: terminal, package managers, services, and project automation
- `full`: unrestricted host-level control

## Status

This repository is an active alpha. The local stdio MCP core and initial cross-platform computer-use layer are implemented. Remote ChatGPT connectivity, durable sessions, approval UX, richer window/UI automation, multi-monitor support, OCR/accessibility-tree extraction, browser control, and installers are next.
