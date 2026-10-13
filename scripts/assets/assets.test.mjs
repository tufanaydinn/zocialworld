// Tests for the asset tooling: the ZIP reader, the character rebuild, the registry and the fetch-and-verify flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { listZip, readZipEntry } from "./zip.mjs";
import { CHARACTER_CLIPS, processCharacter, readGlb, writeGlb } from "./process-characters.mjs";
import { CONTENT_REGISTRY_PATH, checkPack, fetchPack, loadRegistry, registryProblems, sha256 } from "./fetch.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Builds a ZIP archive (one stored entry, the rest deflated) with a central directory. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  Object.entries(files).forEach(([name, content], i) => {
    const data = Buffer.from(content);
    const method = i === 0 ? 0 : 8;
    const body = method === 0 ? data : deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A tiny skinned character: two body meshes, a sword in a hand slot, a kept and a dropped clip. */
function makeCharacter() {
  const floats = (values) => Buffer.from(new Float32Array(values).buffer);
  const views = [floats([0, 0, 0, 1, 0, 0, 0, 1, 0]), floats([5, 5, 5, 6, 5, 5, 5, 6, 5]), floats([0, 1]), floats([0, 0, 0, 0, 1, 0]), floats([9, 9, 9, 9]), floats(new Array(16).fill(0).map((_, i) => (i % 5 === 0 ? 1 : 0)))];
  let offset = 0;
  const bufferViews = views.map((v) => {
    const view = { buffer: 0, byteOffset: offset, byteLength: v.length };
    offset += v.length;
    return view;
  });
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Rig", children: [1, 2, 3] },
      { name: "hips" },
      { name: "Body", mesh: 0, skin: 0 },
      { name: "handslot.r", children: [4] },
      { name: "1H_Sword", mesh: 1 },
    ],
    meshes: [
      { name: "body", primitives: [{ attributes: { POSITION: 0 }, material: 0 }] },
      { name: "sword", primitives: [{ attributes: { POSITION: 1 }, material: 1 }] },
    ],
    materials: [{ name: "skin" }, { name: "steel", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: "steel.png" }],
    skins: [{ joints: [1], inverseBindMatrices: 5 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 2, type: "SCALAR" },
      { bufferView: 3, componentType: 5126, count: 2, type: "VEC3" },
      { bufferView: 4, componentType: 5126, count: 1, type: "VEC4" },
      { bufferView: 5, componentType: 5126, count: 1, type: "MAT4" },
    ],
    bufferViews,
    buffers: [{ byteLength: offset }],
    animations: [
      { name: "Idle", samplers: [{ input: 2, output: 3 }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] },
      { name: "1H_Melee_Attack_Chop", samplers: [{ input: 2, output: 3 }, { input: 2, output: 4 }], channels: [{ sampler: 0, target: { node: 4, path: "translation" } }, { sampler: 1, target: { node: 1, path: "rotation" } }] },
    ],
  };
  return writeGlb(json, Buffer.concat(views));
}

test("listZip/readZipEntry read stored and deflated entries", () => {
  const zip = makeZip({ "License.txt": "CC0", "Models/GLB format/a.glb": "model-a".repeat(50), "Models/": "" });
  const entries = listZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ["License.txt", "Models/GLB format/a.glb", "Models/"]);
  assert.equal(entries[2].directory, true);
  assert.equal(readZipEntry(zip, entries[0]).toString(), "CC0");
  assert.equal(readZipEntry(zip, entries[1]).toString(), "model-a".repeat(50));
  assert.throws(() => listZip(Buffer.from("not a zip at all, definitely not")), /not a zip/);
});

test("processCharacter keeps the game's clips and drops held props and what only they used", () => {
  const out = processCharacter(makeCharacter());
  const { json, bin } = readGlb(out);
  assert.deepEqual(json.nodes.map((n) => n.name), ["Rig", "hips", "Body", "handslot.r"]);
  assert.deepEqual(json.nodes[0].children, [1, 2, 3]);
  assert.equal(json.nodes[3].children, undefined);
  assert.deepEqual(json.meshes.map((m) => m.name), ["body"]);
  assert.deepEqual(json.materials.map((m) => m.name), ["skin"]);
  assert.equal(json.textures, undefined);
  assert.equal(json.images, undefined);
  assert.deepEqual(json.animations.map((a) => a.name), ["Idle"]);
  assert.equal(json.accessors.length, 4); // body positions, clip times, clip values, inverse bind matrices
  assert.deepEqual(json.skins[0].joints, [1]);
  assert.equal(json.buffers[0].byteLength, bin.length);
  for (const view of json.bufferViews) assert.equal(view.byteOffset % 4, 0);
  // The body's vertex data is carried over unchanged.
  const pos = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
  const view = json.bufferViews[pos.bufferView];
  assert.deepEqual([...new Float32Array(bin.buffer.slice(bin.byteOffset + view.byteOffset, bin.byteOffset + view.byteOffset + view.byteLength))], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  // Deterministic: the same input gives the same bytes.
  assert.equal(sha256(processCharacter(makeCharacter())), sha256(out));
  assert.ok(CHARACTER_CLIPS.includes("Sit_Chair_Idle"));
});

test("the asset registry is complete: sources pinned, every file hashed, licence copies verbatim", () => {
  const registry = loadRegistry();
  assert.deepEqual(registryProblems(registry), []);
  for (const pack of registry) {
    const licence = pack.files.find((f) => f.path === "LICENSE.txt");
    assert.ok(licence, `${pack.id} lists its LICENSE.txt`);
    assert.ok(existsSync(join(REPO, pack.licenseFile)), `${pack.licenseFile} exists`);
    assert.equal(sha256(readFileSync(join(REPO, pack.licenseFile))), licence.sha256, `${pack.licenseFile} is the pack's own licence text`);
    assert.match(pack.license, /^CC0-1\.0/);
  }
  const characters = registry.find((p) => p.id === "kaykit-character-pack-adventures-1.0");
  assert.equal(characters.files.filter((f) => f.process === "character").length, 5);
  assert.deepEqual(registryProblems([{ id: "x", location: "/etc", source: { kind: "ftp" }, files: [] }]).length > 0, true);
});

test("fetchPack writes only files whose hash matches, from a zip and from repository files", async () => {
  const work = mkdtempSync(join(tmpdir(), "zw-assets-"));
  try {
    const mirror = join(work, "mirror");
    const root = join(work, "root");
    mkdirSync(join(mirror, "Pack-Repo", "gltf"), { recursive: true });
    const zip = makeZip({ "License.txt": "zip licence", "Models/GLB format/a.glb": "AAAA" });
    writeFileSync(join(mirror, "pack.zip"), zip);
    const character = makeCharacter();
    writeFileSync(join(mirror, "Pack-Repo", "gltf", "Hero.glb"), character);
    writeFileSync(join(mirror, "Pack-Repo", "gltf", "crate.gltf.glb"), "crate");
    const zipPack = {
      id: "zip-pack",
      location: "apps/web/public/assets/environment/zip-pack",
      source: { kind: "zip", url: "https://example.com/files/pack.zip", sha256: sha256(zip) },
      files: [
        { path: "LICENSE.txt", from: "License.txt", sha256: sha256("zip licence") },
        { path: "a.glb", from: "Models/GLB format/a.glb", sha256: sha256("AAAA") },
      ],
    };
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const gitPack = {
      id: "git-pack",
      location: "apps/web/public/assets/characters/git-pack",
      source: { kind: "git", repository: "https://example.com/org/Pack-Repo", commit, raw: `https://example.com/raw/${commit}/` },
      files: [
        { path: "crate.glb", from: "gltf/crate.gltf.glb", sha256: sha256("crate") },
        { path: "Hero.glb", from: "gltf/Hero.glb", sha256: "f".repeat(64), process: "character", sourceSha256: sha256(character), fetchedSha256: sha256(processCharacter(character)) },
      ],
    };
    assert.deepEqual(registryProblems([zipPack, gitPack]), []);
    const quiet = () => {};
    assert.equal(await fetchPack(zipPack, { root, mirror, log: quiet }), 2);
    assert.equal(await fetchPack(gitPack, { root, mirror, log: quiet }), 2);
    assert.deepEqual(checkPack(zipPack, root), { missing: [], mismatched: [] });
    assert.deepEqual(checkPack(gitPack, root), { missing: [], mismatched: [] });
    assert.equal(readFileSync(join(root, gitPack.location, "crate.glb"), "utf8"), "crate");
    assert.equal(await fetchPack(zipPack, { root, mirror, log: quiet }), 0, "a second run has nothing to do");

    // A tampered source is refused and nothing is written.
    writeFileSync(join(mirror, "Pack-Repo", "gltf", "crate.gltf.glb"), "tampered");
    rmSync(join(root, gitPack.location), { recursive: true });
    await assert.rejects(fetchPack(gitPack, { root, mirror, log: quiet }), /hash mismatch/);
    assert.equal(existsSync(join(root, gitPack.location, "crate.glb")), false);
    writeFileSync(join(mirror, "pack.zip"), Buffer.concat([zip, Buffer.from("x")]));
    rmSync(join(root, zipPack.location), { recursive: true });
    await assert.rejects(fetchPack(zipPack, { root, mirror, log: quiet }), /archive hash mismatch/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("loadRegistry: the production content's registry follows the shared one when it exists", () => {
  const work = mkdtempSync(join(tmpdir(), "zw-registry-"));
  try {
    mkdirSync(join(work, "assets"), { recursive: true });
    writeFileSync(join(work, "assets", "asset-registry.json"), JSON.stringify([{ id: "shared" }]));
    assert.deepEqual(loadRegistry(work).map((p) => p.id), ["shared"]);
    mkdirSync(dirname(join(work, CONTENT_REGISTRY_PATH)), { recursive: true });
    writeFileSync(join(work, CONTENT_REGISTRY_PATH), JSON.stringify([{ id: "content-only" }]));
    assert.deepEqual(loadRegistry(work).map((p) => p.id), ["shared", "content-only"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("registry paths cannot escape the pack folder", () => {
  const pack = { id: "p", location: "apps/web/public/assets/props/p", files: [{ path: "../../../../etc/passwd", sha256: "0".repeat(64) }] };
  assert.throws(() => checkPack(pack, "/tmp"), /unsafe path/);
});
