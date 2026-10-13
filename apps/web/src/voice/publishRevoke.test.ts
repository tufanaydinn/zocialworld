import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Track } from "livekit-client";
import { VoiceClient } from "./VoiceClient.ts";

/**
 * When the server revokes this participant's publishing (a stage turn taken by a host, a
 * moderator or the vote; a lost identity), voice drops to listening on the same room — nearby voices and the stage keep
 * playing — instead of switching off. The microphone and any share are stopped and released.
 */

interface FakeTrack {
  readonly name: string;
  stop(): void;
}

test("VoiceClient.dropToListenOnly: stops and unpublishes the microphone and the share, keeps the room, and refuses to publish again", async () => {
  const stopped: string[] = [];
  const unpublished: string[] = [];
  const track = (name: string): FakeTrack => ({ name, stop: () => void stopped.push(name) });
  const publications = new Map<string, { track: FakeTrack }>([
    [Track.Source.Microphone, { track: track("mic") }],
    [Track.Source.ScreenShare, { track: track("screen") }],
    [Track.Source.ScreenShareAudio, { track: track("screen-audio") }],
  ]);
  let disconnected = 0;
  const room = {
    disconnect: () => void disconnected++,
    localParticipant: {
      getTrackPublication: (source: string) => publications.get(source),
      unpublishTrack: async (published: FakeTrack, stopOnUnpublish: boolean) => void unpublished.push(`${published.name}:${stopOnUnpublish}`),
    },
  };
  const states: string[] = [];
  const client = new VoiceClient({ onStateChange: (state) => void states.push(state) });
  Object.assign(client as unknown as { room: unknown; state: string }, { room, state: "connected" });

  await client.dropToListenOnly();

  assert.deepEqual(stopped.sort(), ["mic", "screen", "screen-audio"], "every local track is stopped (the device is released)");
  assert.deepEqual(unpublished.sort(), ["mic:true", "screen-audio:true", "screen:true"]);
  assert.equal(disconnected, 0, "the room is kept");
  assert.equal(client.connectionState, "connected");
  assert.deepEqual(states, [], "no state change: still connected");
  assert.equal(client.isListenOnly, true);
  await assert.rejects(client.enableMicrophone(), /listen-only/);
  await assert.rejects(client.startScreenShare(), /listen-only/);
});

test("VoiceSession.downgradeToListen: listen mode on the same room (no disconnect); nothing to keep when not connected", async () => {
  // THREE.AudioListener needs an AudioContext: a minimal stand-in (nothing is played in this test).
  const node = { connect: () => undefined, disconnect: () => undefined, gain: { value: 1, setTargetAtTime: () => undefined } };
  const context = { createGain: () => node, destination: {}, currentTime: 0, state: "running", resume: async () => undefined };
  const saved = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = { AudioContext: function AudioContext() { return context; } };
  try {
    const { VoiceSession } = await import("./VoiceSession.ts");
    const session = new VoiceSession(
      { camera: new THREE.PerspectiveCamera(), getRemotePlayerObject: () => undefined, isMuted: () => false, isBlocked: () => false, storage: null },
      {},
    );
    const calls: string[] = [];
    const fakeClient = {
      connectionState: "connected",
      dropToListenOnly: async () => void calls.push("drop"),
      disconnect: () => void calls.push("disconnect"),
      setTransmitting: async () => void calls.push("transmit"),
    };
    Object.assign(session as unknown as { client: unknown; modeValue: string; transmitting: boolean }, { client: fakeClient, modeValue: "full", transmitting: true });

    assert.equal(await session.downgradeToListen(), true);
    assert.equal(session.connectionMode, "listen");
    assert.equal(session.isTransmitting, false);
    assert.equal(session.isOpenMicLive, false);
    assert.deepEqual(calls, ["drop"], "the microphone and share are dropped; the room is not disconnected");

    fakeClient.connectionState = "disconnected";
    calls.length = 0;
    assert.equal(await session.downgradeToListen(), false, "no room to keep");
    assert.deepEqual(calls, []);
  } finally {
    (globalThis as Record<string, unknown>).window = saved;
  }
});
