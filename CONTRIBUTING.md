# Contributing

## Development

```bash
npm install
npm run check
npm run build
```

Use Node.js 20 or later. Keep runtime dependencies minimal and prefer standard-library implementations for cross-platform operations.

## Tool requirements

Every new tool must:

- Declare an explicit Zod input schema.
- Declare MCP read-only/destructive/open-world annotations where applicable.
- Route filesystem paths through `PolicyEngine.assertPath`.
- Route HTTP targets through `PolicyEngine.assertUrl`.
- Route shell commands through `PolicyEngine.assertCommand`.
- Return bounded output.
- Be covered by audit logging through `ToolContext.register`.
- Include tests for policy-sensitive behavior.

## Pull requests

Keep each pull request focused. Describe platform behavior and include Windows/macOS/Linux notes when the implementation differs.
