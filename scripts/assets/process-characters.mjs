#!/usr/bin/env node
// Rebuilds the game's KayKit Adventures characters from the pack's original GLB files:
//   - keeps only the animation clips the game plays (CHARACTER_CLIPS);
//   - removes the weapon, shield and mug meshes the characters hold (nodes whose name matches HELD_PROP);
//   - drops everything left unreferenced (meshes, skins, accessors, materials, textures, images, buffer views)
//     and repacks the binary chunk.
// The result is deterministic: the same input always gives the same bytes. It uses no third-party code.
//
//   node scripts/assets/process-characters.mjs <in.glb> <out.glb>
//
// `npm run assets:fetch` runs it on the five characters and checks each result against `assets/asset-registry.json`.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Clips the character controller, the sitting poses and the emotes use. */
export const CHARACTER_CLIPS = Object.freeze([
  "Idle",
  "Unarmed_Idle",
  "Walking_A",
  "Walking_B",
  "Running_A",
  "Sit_Chair_Idle",
  "Sit_Floor_Idle",
  "Cheer",
  "Interact",
  "Use_Item",
  "Spellcasting",
]);

/** Held props removed from the characters (matched against the names of nodes that carry a mesh). */
export const HELD_PROP = /sword|shield|axe|crossbow|dagger|staff|wand|spellbook|quiver|arrow|mug|smokebomb/i;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Splits a GLB into its JSON document and binary chunk. */
export function readGlb(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error("not a GLB file");
  if (buf.readUInt32LE(4) !== 2) throw new Error("only glTF 2.0 binaries are supported");
  let p = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (p + 8 <= buf.length) {
    const length = buf.readUInt32LE(p);
    const type = buf.readUInt32LE(p + 4);
    const data = buf.subarray(p + 8, p + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString("utf8"));
    else if (type === CHUNK_BIN) bin = Buffer.from(data);
    p += 8 + length;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  return { json, bin };
}

/** Writes a GLB from a JSON document and one binary chunk (the document's only buffer). */
export function writeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
  const total = 12 + 8 + jsonPadded.length + (binPadded.length > 0 ? 8 + binPadded.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonPadded.copy(out, 20);
  if (binPadded.length > 0) {
    const p = 20 + jsonPadded.length;
    out.writeUInt32LE(binPadded.length, p);
    out.writeUInt32LE(CHUNK_BIN, p + 4);
    binPadded.copy(out, p + 8);
  }
  return out;
}

/** Keeps the items whose index is in `used`, in their original order, and returns old index -> new index. */
function compact(list, used) {
  const map = new Map();
  const kept = [];
  (list ?? []).forEach((item, i) => {
    if (used.has(i)) {
      map.set(i, kept.length);
      kept.push(item);
    }
  });
  return { kept, map };
}

/** Every `{ index }` texture reference inside a material (core textures and extension textures alike). */
function textureRefs(value, out = []) {
  if (Array.isArray(value)) for (const v of value) textureRefs(v, out);
  else if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) {
      if (/texture$/i.test(key) && v && typeof v === "object" && Number.isInteger(v.index)) out.push(v);
      else textureRefs(v, out);
    }
  }
  return out;
}

/**
 * Applies the character rules to a parsed glTF document and its binary chunk and returns the rebuilt pair.
 * Exported for tests; `processCharacter` works on GLB bytes.
 */
export function pruneCharacterDocument(source, sourceBin, { clips = CHARACTER_CLIPS, heldProp = HELD_PROP } = {}) {
  const json = structuredClone(source);
  const keepClips = new Set(clips);
  const nodes = json.nodes ?? [];

  // 1. Held props: the node and everything below it.
  const joints = new Set((json.skins ?? []).flatMap((skin) => skin.joints));
  const removed = new Set();
  const removeTree = (i) => {
    if (joints.has(i)) throw new Error(`node ${nodes[i].name ?? i} is a skin joint and cannot be removed`);
    removed.add(i);
    for (const child of nodes[i].children ?? []) removeTree(child);
  };
  nodes.forEach((node, i) => {
    if (node.mesh !== undefined && heldProp.test(node.name ?? "")) removeTree(i);
  });
  const usedNodes = new Set(nodes.map((_, i) => i).filter((i) => !removed.has(i)));
  const { kept: keptNodes, map: nodeMap } = compact(nodes, usedNodes);
  for (const node of keptNodes) {
    if (node.children) {
      node.children = node.children.filter((c) => nodeMap.has(c)).map((c) => nodeMap.get(c));
      if (node.children.length === 0) delete node.children;
    }
  }
  json.nodes = keptNodes;
  for (const scene of json.scenes ?? []) scene.nodes = (scene.nodes ?? []).filter((n) => nodeMap.has(n)).map((n) => nodeMap.get(n));
  for (const skin of json.skins ?? []) {
    skin.joints = skin.joints.map((j) => nodeMap.get(j));
    if (skin.skeleton !== undefined) skin.skeleton = nodeMap.get(skin.skeleton);
  }

  // 2. Animations: the kept clips, without channels that targeted a removed node.
  json.animations = (json.animations ?? []).filter((a) => keepClips.has(a.name));
  for (const animation of json.animations) {
    const channels = animation.channels.filter((c) => c.target.node === undefined || nodeMap.has(c.target.node));
    const usedSamplers = new Set(channels.map((c) => c.sampler));
    const { kept: samplers, map: samplerMap } = compact(animation.samplers, usedSamplers);
    animation.samplers = samplers;
    animation.channels = channels.map((c) => ({
      ...c,
      sampler: samplerMap.get(c.sampler),
      target: c.target.node === undefined ? c.target : { ...c.target, node: nodeMap.get(c.target.node) },
    }));
  }
  if (json.animations.length === 0) delete json.animations;

  // 3. Meshes and skins still referenced by a node.
  const { kept: meshes, map: meshMap } = compact(json.meshes, new Set(json.nodes.filter((n) => n.mesh !== undefined).map((n) => n.mesh)));
  const { kept: skins, map: skinMap } = compact(json.skins, new Set(json.nodes.filter((n) => n.skin !== undefined).map((n) => n.skin)));
  for (const node of json.nodes) {
    if (node.mesh !== undefined) node.mesh = meshMap.get(node.mesh);
    if (node.skin !== undefined) node.skin = skinMap.get(node.skin);
  }
  json.meshes = meshes;
  json.skins = skins;

  // 4. Materials, textures, images and samplers.
  const usedMaterials = new Set();
  for (const mesh of json.meshes) for (const prim of mesh.primitives) if (prim.material !== undefined) usedMaterials.add(prim.material);
  const { kept: materials, map: materialMap } = compact(json.materials, usedMaterials);
  for (const mesh of json.meshes) for (const prim of mesh.primitives) if (prim.material !== undefined) prim.material = materialMap.get(prim.material);
  json.materials = materials;
  const refs = textureRefs(json.materials);
  const { kept: textures, map: textureMap } = compact(json.textures, new Set(refs.map((r) => r.index)));
  for (const ref of refs) ref.index = textureMap.get(ref.index);
  json.textures = textures;
  const { kept: images, map: imageMap } = compact(json.images, new Set(json.textures.filter((t) => t.source !== undefined).map((t) => t.source)));
  const { kept: samplers, map: samplerMap } = compact(json.samplers, new Set(json.textures.filter((t) => t.sampler !== undefined).map((t) => t.sampler)));
  for (const texture of json.textures) {
    if (texture.source !== undefined) texture.source = imageMap.get(texture.source);
    if (texture.sampler !== undefined) texture.sampler = samplerMap.get(texture.sampler);
  }
  json.images = images;
  json.samplers = samplers;

  // 5. Accessors.
  const accessorSlots = [];
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      for (const key of Object.keys(prim.attributes)) accessorSlots.push([prim.attributes, key]);
      if (prim.indices !== undefined) accessorSlots.push([prim, "indices"]);
      for (const target of prim.targets ?? []) for (const key of Object.keys(target)) accessorSlots.push([target, key]);
    }
  }
  for (const animation of json.animations ?? []) for (const s of animation.samplers) accessorSlots.push([s, "input"], [s, "output"]);
  for (const skin of json.skins) if (skin.inverseBindMatrices !== undefined) accessorSlots.push([skin, "inverseBindMatrices"]);
  const { kept: accessors, map: accessorMap } = compact(json.accessors, new Set(accessorSlots.map(([o, k]) => o[k])));
  for (const [o, k] of accessorSlots) o[k] = accessorMap.get(o[k]);
  json.accessors = accessors;

  // 6. Buffer views, repacked into one buffer in their original order (4-byte aligned).
  const viewSlots = [];
  for (const accessor of json.accessors) {
    if (accessor.bufferView !== undefined) viewSlots.push([accessor, "bufferView"]);
    if (accessor.sparse) viewSlots.push([accessor.sparse.indices, "bufferView"], [accessor.sparse.values, "bufferView"]);
  }
  for (const image of json.images) if (image.bufferView !== undefined) viewSlots.push([image, "bufferView"]);
  const { kept: views, map: viewMap } = compact(json.bufferViews, new Set(viewSlots.map(([o, k]) => o[k])));
  for (const [o, k] of viewSlots) o[k] = viewMap.get(o[k]);
  const parts = [];
  let offset = 0;
  json.bufferViews = views.map((view) => {
    if ((view.buffer ?? 0) !== 0) throw new Error("only single-buffer GLB files are supported");
    const pad = (4 - (offset % 4)) % 4;
    if (pad) parts.push(Buffer.alloc(pad));
    offset += pad;
    const bytes = sourceBin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    parts.push(bytes);
    const out = { ...view, buffer: 0, byteOffset: offset };
    offset += view.byteLength;
    return out;
  });
  const bin = Buffer.concat(parts);
  json.buffers = [{ byteLength: bin.length }];

  for (const key of ["meshes", "skins", "materials", "textures", "images", "samplers"]) if (json[key].length === 0) delete json[key];
  return { json, bin };
}

/** Rebuilds one character GLB (bytes in, bytes out). */
export function processCharacter(glb, options) {
  const { json, bin } = readGlb(glb);
  const result = pruneCharacterDocument(json, bin, options);
  return writeGlb(result.json, result.bin);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node scripts/assets/process-characters.mjs <in.glb> <out.glb>");
    process.exit(2);
  }
  const out = processCharacter(readFileSync(input));
  writeFileSync(output, out);
  console.log(`${output}: ${out.length} bytes`);
}
