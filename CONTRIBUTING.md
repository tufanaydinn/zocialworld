# Contributing

Thank you for your interest in this project.

## Development Workflow

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes
4. Run validation locally (see below)
5. Push to your fork and open a pull request

## Local Setup

```bash
# Install dependencies
npm install

# Run development servers (web client + multiplayer server)
npm run dev

# Type checking
npm run typecheck

# Run unit tests
npm test

# Run end-to-end tests
npm run test:e2e
```

## Code Quality

Before pushing, ensure:
- **No TypeScript errors:** `npm run typecheck`
- **No build errors:** `npm run build`
- **Tests pass:** `npm test` and `npm run test:e2e`

## Manual Verification

Some features require manual testing with real input devices:

### Camera and Mouse-Look (CORE-001)
1. `npm run dev` from the repository root
2. Open the app in a real browser and click the canvas
3. Confirm the cursor disappears and mouse movement orbits the camera
4. Confirm mouse wheel zooms the camera smoothly
5. Walk toward a building and confirm the camera pulls in without clipping through walls
6. Press Esc to unlock the pointer

### Social Features (CORE-003)
When adding social identity features, test with two real browser windows:
1. `npm run dev`
2. Open two browser tabs/windows at the dev URL
3. Set nicknames in each (e.g., "Alice" and "Bob")
4. Walk one player near the other and press E to open the player context card
5. Test Block functionality: confirm the blocked player's nameplate disappears locally
6. Confirm the project board interaction (`[E] View Projects`) continues to work normally

### Voice Testing (CORE-004)

**Automated tests** verify the connection/subscription pipeline without real audio:
```bash
npm run test:e2e
```

**Real voice testing** requires a self-hosted LiveKit server (not part of default CI):
1. Run `livekit-server --dev` in a separate terminal and note the printed `devkey` and `secret`
2. Copy `devkey` and `secret` into `apps/server/.env` as `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`
3. `npm run dev`
4. Open two browser tabs with real microphone/speaker devices (or real headphones to avoid feedback)
5. Click "Enable Voice" in each tab
6. Hold `V` and speak; confirm the other tab hears the voice with distance-based attenuation
7. Test Mute and Block on the player context card

## Guidelines

- Do not commit `.env` files or secrets of any kind — `.env.example` files are public and tracked
- External assets (models, textures, audio) must have compatible open-source licenses documented in `assets/LICENSES.md`
- Changes to privacy/security-sensitive systems (multiplayer presence, voice transport, wallet integration) require careful review — see `docs/privacy/PRIVACY_MODEL.md`
- Real LiveKit/SFU voice integration tests (`voice-integration.spec.ts`) require external infrastructure and are skipped by default — see `tests/e2e/README.md` for manual verification procedures
- Experimental wallet functionality must never be used with meaningful funds unless explicitly documented as production-ready

## Questions?

See `docs/architecture/OVERVIEW.md` for system design overview and `docs/decisions/` for architecture decisions.
