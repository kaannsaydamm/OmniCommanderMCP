# Security Policy

## Security boundary

Omni Commander executes with the permissions of the operating-system account that launches it. It does not provide privilege escalation, sandbox escape, authentication bypass or operating-system policy bypass.

The `full` profile removes Omni Commander's own path, command, private-network and environment restrictions. It should be treated as equivalent to granting the connected MCP client an interactive terminal under the launching user account.

## Recommended deployment

1. Use `safe` unless unrestricted access is necessary.
2. Use a dedicated low-privilege OS account for autonomous agents.
3. Restrict `allowedRoots` to project directories, not an entire home drive.
4. Keep audit logging enabled and protect the audit directory.
5. Do not expose stdio through an unauthenticated network bridge.
6. Review the MCP client's tool-confirmation and prompt-injection protections.
7. Keep credentials outside readable project files where possible.
8. Run endpoint protection and OS updates normally.

## Safe-profile controls

- Canonicalized path checks against configured roots.
- Symlink-aware parent resolution for paths that do not yet exist.
- Command-pattern deny rules for common destructive operations.
- Loopback/private-network blocking for HTTP tools.
- Environment-value reads disabled.
- Bounded file, output, session and search buffers.
- Audit argument redaction for common secret-bearing keys.

These controls reduce accidental damage. They are not a complete sandbox and must not be treated as one.

## Full-profile invariants

Even in `full`:

- `fs_delete` refuses a filesystem-root target. An explicit shell command remains possible.
- The server refuses to kill its own PID through `process_kill`.
- Request and buffer limits remain finite but are significantly larger.
- Audit logging remains enabled unless explicitly disabled.

## Reporting vulnerabilities

Open a private GitHub security advisory when available. Include:

- Affected version and platform.
- Reproduction steps.
- Expected and actual behavior.
- Security impact.
- A minimal proof of concept without unrelated sensitive data.

Do not publish active exploitation details before a fix is available.
