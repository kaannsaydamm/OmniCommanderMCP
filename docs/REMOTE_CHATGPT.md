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

1. Materialize and build the project with `npm run materialize && npm install && npm run build`.
2. Create a tunnel in OpenAI Platform tunnel settings.
3. Associate it with the correct Platform organization and ChatGPT workspace.
4. Ensure the operator has Tunnels Read + Use; Manage is required to create or edit tunnels.
5. Download the latest official `tunnel-client` binary.
6. Set `CONTROL_PLANE_API_KEY` only in the local environment or a protected service environment file.
7. Run one of the setup scripts included in the materialized source under `scripts/`.
8. Run `tunnel-client doctor --profile omni-commander --explain`.
9. Keep `tunnel-client run --profile omni-commander` alive.
10. In ChatGPT developer mode, create an app and select Tunnel as the connection.

## Diagnostics

```bash
tunnel-client doctor --profile omni-commander --explain
```

Common causes of failure:

- The tunnel process stopped.
- The runtime API key is absent or expired.
- The tunnel is associated with a Platform organization but not the ChatGPT workspace.
- The ChatGPT operator lacks developer mode or Tunnels Read + Use.
- The MCP command points to an old or missing build.
- The agent runs in a service session that cannot access the interactive desktop.
- macOS Accessibility or Screen Recording permissions are not granted.
- Linux uses a restrictive Wayland compositor without an input backend.

## Security notes

- Keep audit logging enabled.
- Run under a dedicated user account where practical.
- Treat tunnel profile configuration and API keys as secrets.
- Do not place API keys in the repository, command history, screenshots or MCP tool output.
- Prefer stdio behind Secure MCP Tunnel to a public network listener.
