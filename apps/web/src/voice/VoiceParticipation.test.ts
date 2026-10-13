import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { bindVoiceParticipation } from "./VoiceParticipation.ts";
import type { ParticipationCapabilities } from "../zcash/participation.ts";
import type { VoiceSession } from "./VoiceSession.ts";
import type { VoiceControls } from "./VoiceControls.ts";

describe("VoiceParticipation binding", () => {
  let mockVoiceSession: {
    disableVoice: () => Promise<void>;
  };
  let mockVoiceControls: {
    setConnectionState: (state: string) => void;
  };
  let subscribers: ((caps: ParticipationCapabilities) => void)[] = [];
  let mockSubscribe: (callback: (caps: ParticipationCapabilities) => void) => () => void;

  beforeEach(() => {
    subscribers = [];

    mockVoiceSession = {
      disableVoice: async () => {},
    };

    mockVoiceControls = {
      setConnectionState: () => {},
    };

    mockSubscribe = (callback) => {
      subscribers.push(callback);
      // Fire immediately with current state (guest by default)
      callback({ canVoice: false, canSupportProjects: false });
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    };
  });

  it("ready → locked → disableVoice called exactly once", async () => {
    let disableVoiceCallCount = 0;
    mockVoiceSession.disableVoice = async () => {
      disableVoiceCallCount++;
    };

    const unsubscribe = bindVoiceParticipation({
      subscribeToCapabilities: mockSubscribe,
      voiceSession: mockVoiceSession as unknown as VoiceSession,
      voiceControls: mockVoiceControls as unknown as VoiceControls,
    });

    // Initial state: guest (callback fired immediately on subscribe)
    assert.equal(disableVoiceCallCount, 0, "disableVoice not called for initial guest state");

    // Transition to ready
    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));
    assert.equal(disableVoiceCallCount, 0, "disableVoice not called on ready transition");

    // Transition to locked
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(disableVoiceCallCount, 1, "disableVoice called exactly once on lock");

    unsubscribe();
  });

  it("repeated locked states do not re-call disableVoice (idempotent)", async () => {
    let disableVoiceCallCount = 0;
    mockVoiceSession.disableVoice = async () => {
      disableVoiceCallCount++;
    };

    const unsubscribe = bindVoiceParticipation({
      subscribeToCapabilities: mockSubscribe,
      voiceSession: mockVoiceSession as unknown as VoiceSession,
      voiceControls: mockVoiceControls as unknown as VoiceControls,
    });

    // Move to ready
    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));

    // Transition to locked
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(disableVoiceCallCount, 1, "First lock calls disableVoice");

    // Repeat locked state multiple times
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(
      disableVoiceCallCount,
      1,
      "Repeated locked states do not re-call disableVoice"
    );

    unsubscribe();
  });

  it("resets VoiceControls state on lock", async () => {
    let controlsState: string | null = null;
    mockVoiceControls.setConnectionState = (state) => {
      controlsState = state;
    };

    const unsubscribe = bindVoiceParticipation({
      subscribeToCapabilities: mockSubscribe,
      voiceSession: mockVoiceSession as unknown as VoiceSession,
      voiceControls: mockVoiceControls as unknown as VoiceControls,
    });

    // Move to ready
    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));
    assert.equal(controlsState, null, "Controls not changed when ready");

    // Transition to locked
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(controlsState, "disconnected", "Controls reset to disconnected on lock");

    unsubscribe();
  });

  it("does not call disableVoice or setConnectionState on ready→ready", () => {
    let disableVoiceCallCount = 0;
    let controlsStateChanges = 0;
    mockVoiceSession.disableVoice = async () => {
      disableVoiceCallCount++;
    };
    mockVoiceControls.setConnectionState = () => {
      controlsStateChanges++;
    };

    const unsubscribe = bindVoiceParticipation({
      subscribeToCapabilities: mockSubscribe,
      voiceSession: mockVoiceSession as unknown as VoiceSession,
      voiceControls: mockVoiceControls as unknown as VoiceControls,
    });

    // Move to ready
    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));

    // Repeat ready state
    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));

    assert.equal(disableVoiceCallCount, 0, "disableVoice not called for ready→ready");
    assert.equal(controlsStateChanges, 0, "controls state not changed for ready→ready");

    unsubscribe();
  });

  it("handles rapid state transitions correctly", async () => {
    let disableVoiceCallCount = 0;
    mockVoiceSession.disableVoice = async () => {
      disableVoiceCallCount++;
    };

    const unsubscribe = bindVoiceParticipation({
      subscribeToCapabilities: mockSubscribe,
      voiceSession: mockVoiceSession as unknown as VoiceSession,
      voiceControls: mockVoiceControls as unknown as VoiceControls,
    });

    // Rapid transitions: guest → ready → locked → ready → locked
    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(disableVoiceCallCount, 1, "First lock");

    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(disableVoiceCallCount, 2, "Second lock after re-enabling");

    unsubscribe();
  });

  it("unsubscribe stops listening to capability changes", async () => {
    let disableVoiceCallCount = 0;
    mockVoiceSession.disableVoice = async () => {
      disableVoiceCallCount++;
    };

    const unsubscribe = bindVoiceParticipation({
      subscribeToCapabilities: mockSubscribe,
      voiceSession: mockVoiceSession as unknown as VoiceSession,
      voiceControls: mockVoiceControls as unknown as VoiceControls,
    });

    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));
    unsubscribe();

    // After unsubscribe, changes should not trigger the binding
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(
      disableVoiceCallCount,
      0,
      "disableVoice not called after unsubscribe"
    );
  });

  it("a wallet lock leaves a listen-only watch-mode connection alone (watching needs no wallet)", () => {
    let disableVoiceCallCount = 0;
    const session = {
      connectionMode: "listen",
      disableVoice: () => {
        disableVoiceCallCount++;
      },
    };

    const unsubscribe = bindVoiceParticipation({
      subscribeToCapabilities: mockSubscribe,
      voiceSession: session as unknown as VoiceSession,
      voiceControls: mockVoiceControls as unknown as VoiceControls,
    });

    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(disableVoiceCallCount, 0, "watch mode survives the lock");

    // Full voice is still ended by a lock.
    session.connectionMode = "full";
    subscribers.forEach((cb) => cb({ canVoice: true, canSupportProjects: true }));
    subscribers.forEach((cb) => cb({ canVoice: false, canSupportProjects: false }));
    assert.equal(disableVoiceCallCount, 1, "full voice ends on lock");

    unsubscribe();
  });
});
