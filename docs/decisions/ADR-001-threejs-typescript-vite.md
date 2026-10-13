# ADR-001: Three.js + TypeScript + Vite as the client stack

## Status

Accepted (2026-10-02)

## Context

The product needs a lightweight, browser-native 3D social world: no
native app, no heavy game-engine download, playable from a link.
The surrounding product surface — project pages, wallet prompts,
comments, profiles — needs to behave like a normal modern web
application, not a game-engine-hosted UI overlay.

Candidates considered: Unity WebGL export, Unreal pixel streaming,
Babylon.js, PlayCanvas, raw WebGL, Three.js.

## Decision

Use **Three.js** as the renderer, **TypeScript** for all application
code, and **Vite** as the build tool/dev server.

Reasons:

- Web-native, lightweight, MIT-licensed, huge ecosystem and glTF
  tooling.
- Full control over how the 3D canvas coexists with ordinary DOM/React
  UI — important since most of the product's value (project discovery,
  chat, wallet flows) is UI, not the 3D scene itself.
- Vite gives fast dev-server iteration and a small, modern production
  bundle (the first prototype shipped a 658 KB / 168 KB gzip bundle,
  almost entirely Three.js itself).
- Avoids committing to a heavyweight game-engine toolchain (Unity/Unreal)
  that would fight the "it's a web app first" product principle and
  bring licensing/export complexity unrelated to this project's needs.

React was evaluated as optional for UI chrome (menus, HUD, loading
screens). The first prototype did not need it — the UI surface was small
enough for direct DOM manipulation (`apps/web/src/ui/`) without
introducing a second rendering paradigm. This is not a rejection of
React; it can be introduced later if UI complexity grows.

## Consequences

- All future client work (character art loading, multiplayer rendering,
  project UI, wallet modals) builds on this stack.
- The project inherits Three.js's release cadence and occasional
  breaking changes in its `examples/jsm/*` modules (already observed:
  `PCFSoftShadowMap` deprecation between minor versions).
- If UI complexity grows significantly (e.g. a full project discovery
  SPA), introducing React for that surface remains an open option and
  does not require revisiting this ADR.
- Switching the renderer away from Three.js (e.g. to Babylon.js) would
  be an architecture-affecting change requiring a new ADR (see
  `docs/decisions/README.md`).
