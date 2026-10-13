/**
 * Voice participation binding: orchestrates wallet-gated voice lifecycle.
 *
 * Extracted into a separate module to enable unit testing of voice shutdown
 * logic independent of the full App wiring.
 */
import type { VoiceSession } from "./VoiceSession.ts";
import type { VoiceControls } from "./VoiceControls.ts";
import type { ParticipationCapabilities } from "../zcash/participation.ts";

export interface VoiceParticipationDeps {
  subscribeToCapabilities: (callback: (caps: ParticipationCapabilities) => void) => () => void;
  voiceSession: VoiceSession;
  voiceControls: VoiceControls;
}

/**
 * Bind voice session to participation capabilities.
 *
 * Monitors wallet lock/unlock transitions and:
 * - Immediately terminates active voice when wallet locks (ready → locked)
 * - Prevents redundant shutdown calls (idempotent)
 * - Resets UI state atomically
 * - Leaves a listen-only watch-mode connection alone: watching needs no
 *   wallet (ADR-014 § 5); talking and presenting do
 *
 * Returns unsubscribe function for cleanup.
 */
export function bindVoiceParticipation(deps: VoiceParticipationDeps): () => void {
  let wasVoiceEligible = false;

  const unsubscribe = deps.subscribeToCapabilities((capabilities) => {
    const isVoiceEligible = capabilities.canVoice;

    // Idempotency: only act on true→false transition (wallet lock)
    if (wasVoiceEligible && !isVoiceEligible && deps.voiceSession.connectionMode !== "listen") {
      deps.voiceSession.disableVoice();
      deps.voiceControls.setConnectionState("disconnected");
    }

    wasVoiceEligible = isVoiceEligible;
  });

  return unsubscribe;
}
