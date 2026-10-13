import { test } from "node:test";
import assert from "node:assert/strict";
import { MAINNET_ANCHORS, NU5_ACTIVATION_HEIGHT, NU7_ACTIVATION_HEIGHT, SAPLING_ACTIVATION_HEIGHT, birthdayYears, estimateBirthday, estimateHeightAt } from "./birthday.ts";

/** ADR-018 § 1: "When did you create this wallet?" → a birthday height (75 s blocks, 25 s after NU7). */

const day = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);
const NOW = day("2026-10-08");

test("the anchors are exact at their activation dates", () => {
  for (const anchor of MAINNET_ANCHORS) assert.equal(estimateHeightAt(anchor.time), anchor.height, anchor.name);
  assert.equal(NU7_ACTIVATION_HEIGHT, null, "set when the mainnet NU7 height is announced (ZIP 259)");
});

test("75-second blocks between anchors: one day after NU6.3 is 1,152 blocks later", () => {
  assert.equal(estimateHeightAt(day("2026-07-29")), 3_428_143 + 1_152);
  // 2026-10-08 is 72 days after NU6.3: ≈ 3,511,087 (the real tip that day was ≈ 3,510,4xx — within a day's blocks).
  const today = estimateHeightAt(NOW);
  assert.equal(today, 3_428_143 + 72 * 1_152);
  assert.ok(Math.abs(today - 3_510_438) < 1_152, `estimate ${today} vs the observed tip 3,510,438`);
});

test("a month/year starts a week before the month, from the right anchor", () => {
  const march2025 = estimateBirthday({ year: 2025, month: 3 }, NOW, { nu7Height: null });
  const expected = estimateHeightAt(Date.UTC(2025, 2, 1) - 7 * 86_400_000, null);
  assert.equal(march2025.height, expected);
  assert.ok(march2025.height > 2_726_400 && march2025.height < 3_428_143, "between NU6 and NU6.3");
  assert.equal(march2025.slow, false);
  assert.equal(march2025.clamped, false);
  const thisMonth = estimateBirthday({ year: 2026, month: 10 }, NOW, { nu7Height: null });
  assert.ok(thisMonth.height < estimateHeightAt(NOW) && thisMonth.height > 3_490_000);
});

test("clamped: before Sapling → Sapling's activation; in the future → just below the estimated tip (or the real one)", () => {
  const old = estimateBirthday({ year: 2017, month: 1 }, NOW, { nu7Height: null });
  assert.equal(old.height, SAPLING_ACTIVATION_HEIGHT);
  assert.equal(old.clamped, true);
  assert.equal(old.slow, true);
  const future = estimateBirthday({ year: 2027, month: 6 }, NOW, { nu7Height: null });
  assert.equal(future.height, estimateHeightAt(NOW, null) - 100);
  assert.equal(future.clamped, true);
  const realTip = estimateBirthday({ year: 2027, month: 6 }, NOW, { nu7Height: null, tipHeight: 3_510_000 });
  assert.equal(realTip.height, 3_509_900);
});

test("\"not sure\" starts at NU5 (2022-05-31) and warns that the scan is slow", () => {
  const unsure = estimateBirthday({ year: null, month: 1 }, NOW);
  assert.deepEqual(unsure, { height: NU5_ACTIVATION_HEIGHT, slow: true, clamped: false });
});

test("with NU7: blocks after its height count at 25 seconds", () => {
  const nu7 = 3_536_000; // a hypothetical activation height for the test
  const nu7Time = MAINNET_ANCHORS[3]!.time + (nu7 - 3_428_143) * 75_000;
  assert.equal(estimateHeightAt(nu7Time, nu7), nu7);
  assert.equal(estimateHeightAt(nu7Time + 86_400_000, nu7), nu7 + 3_456, "one day after NU7: 3,456 blocks (25 s)");
  assert.equal(estimateHeightAt(nu7Time + 86_400_000, null), nu7 + 1_152, "without NU7: 1,152 blocks (75 s)");
  assert.equal(estimateHeightAt(nu7Time - 86_400_000, nu7), nu7 - 1_152, "before NU7 nothing changes");
  const later = Date.UTC(2027, 0, 15);
  const withNu7 = estimateBirthday({ year: 2026, month: 12 }, later, { nu7Height: nu7 });
  const withoutNu7 = estimateBirthday({ year: 2026, month: 12 }, later, { nu7Height: null });
  assert.ok(withNu7.height > withoutNu7.height, "25-second blocks after NU7 put December higher");
});

test("the year list runs from this year back to 2018", () => {
  const years = birthdayYears(NOW);
  assert.equal(years[0], 2026);
  assert.equal(years.at(-1), 2018);
  assert.equal(years.length, 9);
});
