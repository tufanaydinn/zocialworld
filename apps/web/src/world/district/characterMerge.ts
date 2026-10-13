import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Collapses a KayKit character (6 skinned body parts + rigid cape/hat
 * parented to bones, one shared material) into ONE skinned mesh on the
 * shared skeleton: identical pose and pixels, 1 draw call instead of ~7
 * (and one bone-texture upload instead of six).
 *
 * Rigid parts become skinned with full weight on the bone they hang
 * from. Rendered position of a skinned vertex (attached bind mode) is
 * `bone.matrixWorld · boneInverse · bindMatrix · v`, so a rigid vertex
 * `v_local` maps to `v = bindMatrix⁻¹ · boneInverse⁻¹ · bone.matrixWorld⁻¹ · part.matrixWorld · v_local`.
 *
 * Returns false (leaving the model untouched) if the parts don't share
 * a material/skeleton the way the merge assumes.
 */
export function mergeCharacterMeshes(model: THREE.Object3D): boolean {
  model.updateMatrixWorld(true);
  const skinned: THREE.SkinnedMesh[] = [];
  const rigid: THREE.Mesh[] = [];
  model.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !isShown(mesh)) return;
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(mesh as THREE.SkinnedMesh);
    else rigid.push(mesh);
  });
  const base = skinned[0];
  if (!base || Array.isArray(base.material)) return false;
  const material = base.material;
  const bones = base.skeleton.bones;
  const boneIndex = new Map(bones.map((bone, index) => [bone, index]));
  const baseBindInverse = base.bindMatrix.clone().invert();

  const parts: THREE.BufferGeometry[] = [];
  const matrix = new THREE.Matrix4();
  const offset = new THREE.Matrix4();
  const check = new THREE.Matrix4();
  for (const mesh of skinned) {
    if (mesh.material !== material) return false;
    // Each part was bound in its own mesh space: its inverse bind matrices differ from the base's by one constant
    // offset X (IBM_part = IBM_base · X), which is folded into the vertices.
    const remap: number[] = [];
    for (const [index, bone] of mesh.skeleton.bones.entries()) {
      const target = boneIndex.get(bone);
      if (target === undefined) return false;
      check.copy(base.skeleton.boneInverses[target]!).invert().multiply(mesh.skeleton.boneInverses[index]!);
      if (index === 0) offset.copy(check);
      else if (!nearlyEqual(check, offset)) return false;
      remap.push(target);
    }
    matrix.copy(baseBindInverse).multiply(offset).multiply(mesh.bindMatrix);
    const geometry = plainGeometry(mesh.geometry).applyMatrix4(matrix);
    const skinIndex = geometry.getAttribute("skinIndex") as THREE.BufferAttribute;
    for (let i = 0; i < skinIndex.count; i++) {
      for (let c = 0; c < 4; c++) skinIndex.setComponent(i, c, remap[skinIndex.getComponent(i, c)] ?? 0);
    }
    parts.push(geometry);
  }
  for (const mesh of rigid) {
    if (mesh.material !== material) return false;
    let bone: THREE.Object3D | null = mesh.parent;
    while (bone && !boneIndex.has(bone as THREE.Bone)) bone = bone.parent;
    if (!bone) return false;
    const index = boneIndex.get(bone as THREE.Bone)!;
    matrix
      .copy(baseBindInverse)
      .multiply(base.skeleton.boneInverses[index]!.clone().invert())
      .multiply(bone.matrixWorld.clone().invert())
      .multiply(mesh.matrixWorld);
    const geometry = plainGeometry(mesh.geometry).applyMatrix4(matrix);
    const count = geometry.getAttribute("position").count;
    const indices = new Float32Array(count * 4);
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      indices[i * 4] = index;
      weights[i * 4] = 1;
    }
    geometry.setAttribute("skinIndex", new THREE.BufferAttribute(indices, 4));
    geometry.setAttribute("skinWeight", new THREE.BufferAttribute(weights, 4));
    parts.push(geometry);
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) return false;

  const result = new THREE.SkinnedMesh(merged, material);
  result.name = "MergedCharacter";
  result.castShadow = base.castShadow;
  result.receiveShadow = base.receiveShadow;
  result.frustumCulled = false;
  result.position.copy(base.position);
  result.quaternion.copy(base.quaternion);
  result.scale.copy(base.scale);
  base.parent!.add(result);
  result.bind(base.skeleton, base.bindMatrix);
  for (const mesh of [...skinned, ...rigid]) mesh.removeFromParent();
  // Hidden parts (helmets, knives) stay hidden; drop them too so nothing else renders.
  const hidden: THREE.Object3D[] = [];
  model.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && object !== result) hidden.push(object);
  });
  for (const object of hidden) object.removeFromParent();
  return true;
}

function nearlyEqual(a: THREE.Matrix4, b: THREE.Matrix4): boolean {
  return a.elements.every((value, i) => Math.abs(value - b.elements[i]!) < 1e-3);
}

function isShown(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/** Float position/normal/uv(+skin) copy — glTF parts may use quantized or interleaved attributes. */
function plainGeometry(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv", "skinIndex", "skinWeight"]) {
    const attribute = source.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!attribute) continue;
    const array = new Float32Array(attribute.count * attribute.itemSize);
    for (let i = 0; i < attribute.count; i++) {
      for (let c = 0; c < attribute.itemSize; c++) array[i * attribute.itemSize + c] = attribute.getComponent(i, c);
    }
    // Normalized integer skin weights / uvs read back as floats via getComponent's normalization.
    geometry.setAttribute(name, new THREE.BufferAttribute(array, attribute.itemSize));
  }
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  const index = source.getIndex();
  geometry.setIndex(index ? Array.from(index.array as ArrayLike<number>) : [...Array(geometry.getAttribute("position").count).keys()]);
  return geometry;
}
