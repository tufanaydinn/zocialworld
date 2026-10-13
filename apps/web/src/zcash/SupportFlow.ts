// Zcash support payment flow for projects in Zocial World.
// Handles: support intent creation, memo building, confirmation, and sending.

import { buildZip321Uri, type Zip321Request } from "./core/wallet-types";
import { formatZatoshiToZecDecimal } from "./core/decimal";
import type { ProjectSupportTarget, SupportIntent, SupportConfirmation } from "./WalletTypes";
import { validateSupportTarget } from "./config";

// Re-export types for convenience
export type { ProjectSupportTarget, SupportIntent, SupportConfirmation };

/** Support payment memo: defaults to EMPTY (no on-chain metadata).
 *  Privacy-minimal approach: project selection already exists in application state.
 *  On-chain metadata leakage (projectId, amount, timestamp) is not necessary.
 *  Future: if on-chain proofs of support donation are required, can enable memo.
 */
export function buildSupportMemo(_target: ProjectSupportTarget, _amountZatoshi: bigint): string {
  // Default: no memo. Shielded transactions hide amount/recipient by default.
  // Adding application-level metadata to the memo reduces privacy benefits.
  return "";
}

/** Create a support intent from project target and amount (bigint zatoshi). */
export function createSupportIntent(
  target: ProjectSupportTarget,
  amountZatoshi: bigint
): SupportIntent {
  // Validate the target against current network config
  const validation = validateSupportTarget(target);
  if (!validation.ok) {
    throw new Error(validation.error || "Invalid support target");
  }

  return {
    target,
    amountZatoshi,
    amountDisplayZec: formatZatoshiToZecDecimal(amountZatoshi),
    memo: buildSupportMemo(target, amountZatoshi),
    createdAt: Date.now(),
  };
}

/** Build a ZIP-321 payment request URI for the support intent. */
export function buildSupportPaymentUri(intent: SupportIntent): string {
  const request: Zip321Request = {
    address: intent.target.recipientAddress,
    amountZecDecimal: intent.amountDisplayZec,
    memo: intent.memo,
    label: `Support: ${intent.target.label}`,
  };
  return buildZip321Uri(request);
}

/** Validate that a support confirmation is correct (for UI review). */
export function validateSupportConfirmation(confirmation: SupportConfirmation): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!confirmation.confirmed) {
    errors.push("Support not confirmed by user");
  }

  if (confirmation.intent.amountZatoshi <= 0n) {
    errors.push("Amount must be positive");
  }

  if (!confirmation.intent.target.recipientAddress) {
    errors.push("Recipient address missing");
  }

  if (!confirmation.intent.target.projectId) {
    errors.push("Project ID missing");
  }

  // Validate network alignment
  const targetValidation = validateSupportTarget(confirmation.intent.target);
  if (!targetValidation.ok) {
    errors.push(targetValidation.error || "Invalid support target");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
