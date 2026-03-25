# AGENTS.md

## Cursor Cloud specific instructions

This is a **Bun workspace monorepo** for `@handstage` — a TypeScript SDK for browser automation via CDP. There are no backend services, databases, or Docker dependencies. Chrome must be available on the system.

### Packages

| Package | Path | Build |
|---|---|---|
| `@handstage/dom` | `pkgs/dom` | `bun run build-dom-scripts && bun run build` |
| `@handstage/core` | `pkgs/core` | `bun run build` (depends on dom) |
| `@handstage/agent` | `pkgs/agent` | No build step (consumed as TS) |

### Key commands

- **Install deps:** `bun install` (from repo root)
- **Lint:** `bun biome check .` (pre-existing warnings/errors in codebase are expected)
- **Build order:** dom scripts first, then dom, then core. Agent has no build step.
  ```
  cd pkgs/dom && bun run build-dom-scripts && bun run build
  cd pkgs/core && bun run build
  ```

### Caveats

- The root `tsconfig.json` has `noEmit: true` and no DOM lib — running `tsc --noEmit` at the root will produce errors for browser-injected DOM scripts. Use per-package build commands instead.
- `@handstage/dom` has generated files (`src/build/*.generated.ts`) produced by `bun run build-dom-scripts`. These must be regenerated after modifying DOM source scripts.
- Chrome/Chromium must be installed; `@handstage/core` uses `chrome-launcher` to find and launch it.
- There are no automated tests in the repository.
