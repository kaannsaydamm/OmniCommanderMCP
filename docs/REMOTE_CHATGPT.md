# Connecting ChatGPT to Omni Commander

## Recommended architecture

```text
ChatGPT web
    │ OpenAI-hosted tunnel endpoint
    ▼
OpenAI Secure MCP Tunnel control plane
    ▲ outbound HTTPS :443
    │
tunnel-client on your computer
    │ private local stdio
    ▼
node dist/index.js --profile=full
    │
    ├── shell / files / processes / OS administration
    └── screenshots / accessibility / mouse / keyboard / windows
```

The computer initiates the network connection. You do not open an inbound port or publish the local MCP server.

## Setup checklist

1. Build the project with `npm ci && npm run build`.
2. Create a tunnel in OpenAI Platform tunnel settings.
3. Associate it with the correct Platform organization and ChatGPT workspace.
4. Ensure the operator has Tunnels Read + Use; Manage is required to create/edit tunnels.
5. Download the latest official `tunnel-client` binary.
6. Set `CONTROL_PLANE_API_KEY` only in the local environment or protected service environment file.
7. Run one of the setup scripts in `scripts/`.
8. Run `tunnel-client doctor --profile omni-commander --explain`.
9. Keep `tunnel-client run --profile omni-commander` alive.
10. In ChatGPT developer mode, create an app and select Tunnel as the connection.

## Persistent startup

### Linux systemd user service

Copy the template:

```bash
mkdir -p ~/.config/systemd/user ~/.config/omni-commander
cp deploy/systemd/omni-tunnel.service ~/.config/systemd/user/
cat > ~/.config/omni-commander/tunnel.env <<'ENV'
CONTROL_PLANE_API_KEY=sk-REPLACE_ME
ENV
chmod 600 ~/.config/omni-commander/tunnel.env
systemctl --user daemon-reload
systemctl --user enable --now omni-tunnel.service
```

Adjust the `tunnel-client` path and profile in the unit when necessary. User lingering may be required when it must run without an interactive login, but graphical computer use still requires access to the active desktop session.

### macOS launchd

Copy and edit the plist template in `deploy/launchd`. `launchd` environment handling is intentionally not used for the API key in the template. Wrap `tunnel-client` with a local script that reads a key from Keychain or another protected secret store, then point `ProgramArguments` to that wrapper.

### Windows Task Scheduler

First configure the tunnel profile and set the API key in the current process. Then:

```powershell
./scripts/install-tunnel-startup.ps1 -Profile omni-commander
```

The script stores the key in the current user's environment and creates an at-logon task. Windows Credential Manager or an enterprise secret-injection mechanism is preferable for managed deployments.

## Diagnostics

```bash
tunnel-client doctor --profile omni-commander --explain
```

Check the tunnel-client loopback operator UI at `/ui`, plus `/healthz`, `/readyz`, and `/metrics` on the port shown by the client.

Common causes of failure:

- The tunnel process stopped.
- The runtime API key is absent or expired.
- The tunnel is associated with a Platform org but not the ChatGPT workspace.
- The ChatGPT operator lacks developer mode or Tunnels Read + Use.
- The MCP command points to an old/missing build.
- The agent runs in a service session that cannot access the interactive desktop.
- macOS Accessibility/Screen Recording permissions are not granted.
- Linux is using a restrictive Wayland compositor without an input backend.

## Security notes

- Keep audit logging enabled.
- Run under a dedicated user account where practical.
- Treat tunnel profile configuration and API keys as secrets.
- Do not place API keys in the repository, command history, screenshots, or MCP tool output.
- Prefer stdio behind Secure MCP Tunnel to a public network listener.
