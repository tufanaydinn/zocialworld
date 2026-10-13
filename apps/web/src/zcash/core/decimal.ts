/**
 * Strict decimal ZEC ↔ zatoshi conversion.
 * No JavaScript floating point in authoritative payment paths.
 * 1 ZEC = 100,000,000 zatoshi
 */

const MAX_DECIMAL_PLACES = 8;

/**
 * Parse user-provided decimal ZEC string to bigint zatoshi.
 *
 * Strict rules:
 * - Exact decimal parsing, no floating point
 * - Max 8 fractional decimals (1 satoshi precision)
 * - No scientific notation (1e3, 1E3 rejected)
 * - No NaN, Infinity, or empty string
 * - No leading + sign ("+1" rejected)
 * - Negative amounts rejected (support requires positive)
 * - Whitespace trimmed from edges only
 * - ".5" normalized to "0.5", "1." to "1.0"
 *
 * @param input User-provided decimal string
 * @returns BigInt zatoshi amount
 * @throws Error if input is invalid
 */
export function parseZecDecimalToZatoshi(input: string): bigint {
  // Trim outer whitespace only
  const trimmed = input.trim();

  // Reject empty, "0", or invalid patterns
  if (!trimmed || trimmed === "0") {
    throw new Error("Amount must be greater than 0");
  }

  // Reject leading +
  if (trimmed.startsWith("+")) {
    throw new Error("Amount must not have a leading + sign");
  }

  // Reject negative
  if (trimmed.startsWith("-")) {
    throw new Error("Amount must be positive");
  }

  // Reject scientific notation
  if (trimmed.toLowerCase().includes("e")) {
    throw new Error("Scientific notation not allowed");
  }

  // Reject special values
  if (trimmed.toLowerCase() === "nan" || trimmed.toLowerCase() === "infinity") {
    throw new Error("Invalid amount");
  }

  // Parse structure: [0-9]+(\.[0-9]+)?
  const parts = trimmed.split(".");

  if (parts.length > 2) {
    throw new Error("Invalid decimal format");
  }

  const integerPart = parts[0];
  const fractionalPart = parts[1] ?? "";

  // Validate integer part
  if (!/^\d+$/.test(integerPart)) {
    throw new Error("Invalid integer part");
  }

  // Validate fractional part
  if (fractionalPart && !/^\d+$/.test(fractionalPart)) {
    throw new Error("Invalid fractional part");
  }

  // Reject >8 decimals
  if (fractionalPart.length > MAX_DECIMAL_PLACES) {
    throw new Error(
      `Maximum ${MAX_DECIMAL_PLACES} decimal places allowed, got ${fractionalPart.length}`
    );
  }

  // Pad fractional part to exactly 8 digits
  const paddedFractional = fractionalPart.padEnd(MAX_DECIMAL_PLACES, "0");

  // Combine: "1.5" → "1" + "50000000" → "150000000" zatoshi
  const zatoshiString = integerPart + paddedFractional;
  const zatoshi = BigInt(zatoshiString);

  return zatoshi;
}

/**
 * Format bigint zatoshi to decimal ZEC string for display.
 * No floating point conversion.
 *
 * @param zatoshi Amount in zatoshi
 * @returns Decimal ZEC string (e.g. "1.5", "0.00000001")
 */
export function formatZatoshiToZecDecimal(zatoshi: bigint): string {
  const zatoshiStr = zatoshi.toString().padStart(9, "0");
  const integerPart = zatoshiStr.slice(0, -8);
  const fractionalPart = zatoshiStr.slice(-8);

  // Remove trailing zeros from fractional part
  const trimmedFractional = fractionalPart.replace(/0+$/, "");

  if (trimmedFractional === "") {
    return integerPart;
  }

  return `${integerPart}.${trimmedFractional}`;
}
