# Omni Commander MCP

Omni Commander is a local-first, cross-platform MCP agent for terminal, filesystem, process, application, window, desktop and operating-system control.

## Current 0.2 feature branch bootstrap

The complete, locally validated 0.2.0 source tree is staged on `feat/remote-computer-use` as a checksum-protected source archive because GitHub-hosted Actions are currently not starting for this repository.

```bash
git clone --branch feat/remote-computer-use https://github.com/kaannsaydamm/OmniCommanderMCP.git
cd OmniCommanderMCP
npm run materialize
npm install
npm run check
npm test
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

## Intended control surfaces

- Local MCP over stdio.
- Authenticated Streamable HTTP.
- OpenAI Secure MCP Tunnel for ChatGPT web without opening inbound ports.
- Filesystem read/write/edit/search/watch operations.
- Interactive and one-shot shell/process sessions.
- Application launch/close and window management.
- Screenshot observation, mouse, keyboard, clipboard and multi-step computer-use actions.
- OCR text discovery and click-by-text.
- Windows UI Automation, macOS Accessibility and Linux AT-SPI integration points.
- Services, packages, disks, users, groups, scheduled tasks, firewall, logs and power operations.
- Network diagnostics and HTTP requests.
- Git and archive operations.
- Safe and full security profiles with JSONL audit logging.

## Security profiles

The default `safe` profile limits filesystem roots, blocks known destructive command patterns, restricts private-network HTTP targets and redacts audit fields.

The explicitly selected `full` profile removes those policy restrictions and runs with the operating-system rights of the local agent process. It does not bypass OS permissions, elevation boundaries or endpoint-security controls.

## Important status

The 0.2.0 source has passed TypeScript type checking, six automated tests and production build locally. It has not yet been exercised on the user's actual Windows desktop because the connected Desktop Commander device is offline. Secure MCP Tunnel setup also requires the user's own OpenAI control-plane access and local tunnel-client authentication.
