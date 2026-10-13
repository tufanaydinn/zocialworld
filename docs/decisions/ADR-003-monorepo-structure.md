# ADR-003: Monorepo structure with npm workspaces

## Status

Accepted (2026-10-02)

## Context

The project spans many subsystems that evolve in parallel: world and
level design, character art, the multiplayer client and server, chat and
social features, project discovery, Zcash integration, UI, performance,
security and testing. Different contributors work on these at the same
time. That requires clear top-level ownership boundaries from the start,
so that changes to one subsystem don't collide on the same files or
silently expand into another subsystem's scope.

The first prototype shipped as a single flat Vite project at the
repository root. That is fine for one web client, but does not scale to multiple apps (web client + future server) and
multiple ownable subsystems (world-core, player, multiplayer, voice,
social, projects, zcash, ui, shared) without either (a) everything living
in one undifferentiated `src/`, or (b) premature package extraction
before there's a second consumer of any given piece of code.

## Decision

Adopt a **monorepo with npm workspaces**:

```text
apps/web/        the actual runnable client (the prototype's code, moved here as-is)
apps/server/     reserved, documentation-only until multiplayer work starts
packages/*/      ownership placeholders (README-only) until a real second
                  consumer justifies extracting shared code
assets/          the asset authoring/license-registry pipeline (not runtime-served)
worlds/          level-design data, separate from engine code
docs/            architecture, privacy, protocols, ADRs
```

Explicitly **not** done in this pass: splitting `apps/web/src/*` into
`packages/*`: working code is not split into packages just to fill
folders. Each placeholder package README documents where its eventual code
currently lives and what would trigger extraction.

npm workspaces (not Turborepo/Nx/pnpm) was chosen for minimalism: a
single-app monorepo does not yet need a dedicated build-orchestration
tool. Root `package.json` scripts (`dev`, `typecheck`, `build`,
`test:e2e`) delegate to the relevant workspace so nobody needs to
remember `cd apps/web` for common commands.

## Consequences

- A single root `package-lock.json` governs all workspace dependencies;
  `apps/web` no longer has its own lockfile.
- CI (`.github/workflows/ci.yml`) runs from the repository root.
- Playwright e2e tests live at the repository root (`tests/e2e/`), not
  inside `apps/web`, since they test the running application as a whole
  and may eventually span more than one app.
- Adding a new top-level directory, or promoting a `packages/*`
  placeholder into real code, requires a new ADR — intentional friction
  to prevent structural drift across many parallel changes.
- If a second app or a genuine cross-app code-sharing need emerges and
  npm workspaces prove insufficient (e.g. for incremental/cached builds
  across many packages), revisiting the build-tool choice is a new ADR,
  not a silent swap.
- Since this decision, `packages/shared` became a real package for the
  wire protocol (ADR-006), and `apps/server` holds the game server.

**Amendment (2026-10-13).** The current layout is `apps/web` (the client),
`apps/server` (the game server) and `packages/shared` (the wire protocol),
with `assets/` holding the asset licence registry. The `worlds/` directory
and the README-only placeholder packages listed above are not part of it.
