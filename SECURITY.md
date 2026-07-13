# Security Policy

## Security boundary

Omni Commander runs with the permissions and desktop session of the OS account that launches it. It does not provide privilege escalation, UAC bypass, sudo bypass, sandbox escape, endpoint-security bypass, or a way around macOS TCC / Linux display-server controls.

The `full` profile is deliberately powerful. Treat it as granting the connected MCP principal:

- An interactive terminal.
- Read/write access wherever the OS account has access.
- Keyboard/mouse/window control of the active desktop where permitted.
- OS administration tools when the process has administrator/root rights.
- Network access available to the host.

## Recommended remote deployment

1. Prefer stdio behind OpenAI Secure MCP Tunnel; do not expose an unauthenticated public listener.
2. Associate the tunnel only with intended Platform organizations and ChatGPT workspaces.
3. Protect the runtime API key and tunnel configuration.
4. Keep the tunnel client and Omni Commander updated.
5. Run under a dedicated user account with only the required data and application access.
6. Keep audit logging enabled and forward logs to protected storage when used operationally.
7. Review client-side tool approvals and prompt-injection defenses.
8. Do not run untrusted files, browse hostile content, or ingest untrusted instructions in a full-control session without additional containment.

## HTTP mode

- Defaults to `127.0.0.1` with SDK host-header validation.
- Requires a bearer token when binding outside loopback.
- The built-in bearer mode is not a complete public internet authentication architecture.
- Public deployments need TLS, OAuth 2.1, strict host/origin controls, rate limiting, revocation, principal-bound authorization, and an external security review.

## Safe-profile controls

- Canonicalized allowed-root checks, including nearest-existing-parent resolution for new paths.
- Common catastrophic command-pattern denial.
- Loopback/private-network SSRF blocking for HTTP tools.
- Environment values hidden.
- Finite file, output, search, and session buffers.
- Audit redaction for common secret-bearing keys.

These controls reduce accidental damage; they are not a complete sandbox.

## Full-profile invariants

- `fs_delete` refuses direct filesystem-root deletion. An explicit shell remains possible by design.
- `process_kill` refuses to kill the MCP server PID.
- Destructive OS administration tools require `full`.
- Limits remain finite, though substantially higher.
- Audit logging remains on unless explicitly disabled.

## Computer-use risks

Computer-use tools can click destructive confirmations, send messages, submit forms, reveal secrets on screen, or operate the wrong window. Autonomous workflows should observe after each meaningful action and verify target application, window title, and resulting state.

OCR is probabilistic. Never treat an OCR match as authorization for financial, credential, legal, deletion, or external-communication actions without additional verification.

## Vulnerability reporting

Use a private GitHub security advisory where available. Include affected version/platform, reproduction, expected/actual behavior, impact, and a minimal proof of concept without unrelated sensitive data.
