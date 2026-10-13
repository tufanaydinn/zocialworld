import { test } from "node:test";
import assert from "node:assert/strict";
import { AVATAR_MODELS } from "../player/avatarModels.ts";
import { avatarModelFor } from "../networking/remoteAvatars.ts";
import { LocalBucket } from "./Emotes.ts";

// The client mirror of the server's reaction/hand buckets, and the deterministic remote avatar model.

test("LocalBucket mirrors the server's reaction bucket: burst 8, then 3 per second", () => {
  const bucket = new LocalBucket(8, 3, 0);
  let sent = 0;
  for (let i = 0; i < 20; i++) if (bucket.take(0)) sent++;
  assert.equal(sent, 8);
  assert.equal(bucket.take(100), false, "0.3 tokens after 100 ms");
  assert.equal(bucket.take(400), true, "a whole token after ~334 ms");
  assert.equal(bucket.take(400), false);
});

test("LocalBucket mirrors the hand bucket: burst 3, then one every 5 s", () => {
  const bucket = new LocalBucket(3, 0.2, 0);
  assert.deepEqual([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)], [true, true, true, false]);
  assert.equal(bucket.take(4900), false);
  assert.equal(bucket.take(5000), true);
});

test("avatarModelFor picks one of the five KayKit models from colorSeed, the same on every client", () => {
  const seen = new Set(Array.from({ length: 50 }, (_, seed) => avatarModelFor(seed * 37)));
  assert.equal(seen.size, AVATAR_MODELS.length, "all five appear");
  assert.equal(avatarModelFor(123), avatarModelFor(123));
  assert.equal(avatarModelFor(Number.NaN), AVATAR_MODELS[0]);
  assert.ok(AVATAR_MODELS.includes(avatarModelFor(-7)));
});
