# audio

Reserved for ambient sound and effects (town loop, tavern ambience, footsteps, fireplace, UI clicks).
Nothing is implemented here yet; the folder documents where that layer will plug in.

## What lives elsewhere

Proximity voice chat and the Watch Hall stage audio are implemented in `apps/web/src/voice/`:
the LiveKit connection (`VoiceClient.ts`), Web Audio spatialization (`VoiceAudioGraph.ts`), the
distance-to-gain policy (`VoiceProximity.ts`) and the hall audio rules (`hallAudio.ts`). What voice
transmits and what it never does is described in `docs/privacy/VOICE_THREAT_MODEL.md` and
`docs/decisions/ADR-007-proximity-voice-transport.md`.

## Notes for an ambient/SFX layer

- A small `AudioManager` wrapping `THREE.AudioListener` / `THREE.PositionalAudio` would fit here.
  `LocalPlayer.object` and `RemotePlayer.object` are the natural attach points, so positional sound
  works the same for local and remote players.
- Voice already owns an `AudioContext` and a listener on the camera (`VoiceAudioGraph.ts`). Reuse
  them rather than creating a second context, and keep ambient gain separate from voice gain.
- Keep sound effects out of the gameplay WebSocket protocol in `src/networking/`: they are local
  presentation, never networked state.
