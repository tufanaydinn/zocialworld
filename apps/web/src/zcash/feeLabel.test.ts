import { test } from "node:test";
import assert from "node:assert/strict";
import { approxUsdSuffix, formatUsd, parseFeeUsd } from "./feeLabel.ts";

// The fiat value next to a fee is the operator's published label (GET /zcash/info), never assumed.

test("parseFeeUsd accepts a published amount (rounded to cents) and refuses anything else", () => {
  assert.equal(parseFeeUsd(1), 1);
  assert.equal(parseFeeUsd(1.25), 1.25);
  assert.equal(parseFeeUsd(0.999), 1);
  for (const bad of [0, -1, 1001, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, {}, 0.001]) assert.equal(parseFeeUsd(bad), null, String(bad));
});

test("formatUsd and approxUsdSuffix", () => {
  assert.equal(formatUsd(1), "US$1");
  assert.equal(formatUsd(1.5), "US$1.50");
  assert.equal(formatUsd(0.75), "US$0.75");
  assert.equal(approxUsdSuffix(1), " ≈ US$1");
  assert.equal(approxUsdSuffix(null), "", "no label published: nothing");
});
