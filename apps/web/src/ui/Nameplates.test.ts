import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import * as THREE from "three";

// Nameplates write their style only when it changes, hide off-screen and far plates, and the hall's
// declutter still places nearest / badged plates first.

const dom = new JSDOM("<!doctype html><html><head></head><body><div id='root'></div></body></html>");
const globals = globalThis as unknown as Record<string, unknown>;
globals.document = dom.window.document;
globals.window = dom.window;
globals.HTMLElement = dom.window.HTMLElement;

const { NAMEPLATE_MAX_DISTANCE, NameplateManager } = await import("./Nameplates.ts");

const W = 1000;
const H = 600;

function setup(): { plates: InstanceType<typeof NameplateManager>; camera: THREE.PerspectiveCamera; element: (id: string) => HTMLDivElement } {
  const root = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(root);
  const plates = new NameplateManager(root as unknown as HTMLElement);
  const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 500);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld();
  const element = (id: string): HTMLDivElement => {
    const match = [...root.querySelectorAll(".zw-nameplate")].find((node) => node.textContent?.startsWith(id));
    assert.ok(match, `plate ${id}`);
    return match as unknown as HTMLDivElement;
  };
  return { plates, camera, element };
}

test("a plate is written once and left alone while it does not move", () => {
  const { plates, camera, element } = setup();
  plates.set("a", "a-player");
  const head = new THREE.Vector3(0, 0, -10);
  plates.update([{ id: "a", headPosition: head }], camera, W, H);
  const plate = element("a");
  assert.equal(plate.style.display, "");
  assert.match(plate.style.transform, /translate\(500px, 300px\)/);
  plate.style.transform = "translate(1px, 1px)";
  plates.update([{ id: "a", headPosition: head }], camera, W, H);
  assert.equal(plate.style.transform, "translate(1px, 1px)", "no write when nothing moved");
  head.x = 0.0001; // far below half a pixel
  plates.update([{ id: "a", headPosition: head }], camera, W, H);
  assert.equal(plate.style.transform, "translate(1px, 1px)", "no write for a sub-pixel move");
  head.x = 1;
  plates.update([{ id: "a", headPosition: head }], camera, W, H);
  assert.notEqual(plate.style.transform, "translate(1px, 1px)");
});

test("off-screen, behind the camera, too far or hidden by the hall policy: display none (written once)", () => {
  const { plates, camera, element } = setup();
  plates.set("b", "b-player");
  const plate = (): HTMLDivElement => element("b");
  const at = (x: number, y: number, z: number, hidden = false): void => plates.update([{ id: "b", headPosition: new THREE.Vector3(x, y, z), hidden }], camera, W, H);
  at(0, 0, -10);
  assert.equal(plate().style.display, "");
  at(60, 0, -10); // far to the right of the frustum
  assert.equal(plate().style.display, "none");
  at(0, 0, 10); // behind
  assert.equal(plate().style.display, "none");
  at(0, 0, -(NAMEPLATE_MAX_DISTANCE + 1));
  assert.equal(plate().style.display, "none");
  at(0, 0, -(NAMEPLATE_MAX_DISTANCE - 1));
  assert.equal(plate().style.display, "");
  at(0, 0, -10, true);
  assert.equal(plate().style.display, "none");
  plate().style.display = "block";
  at(0, 0, -10, true);
  assert.equal(plate().style.display, "block", "an unchanged state is not rewritten");
});

test("declutter: of two overlapping plates the nearer shows, unless the farther one has priority", () => {
  const { plates, camera, element } = setup();
  plates.set("near", "near-player");
  plates.set("far", "far-player");
  const entries = (farPriority: boolean) => [
    { id: "far", headPosition: new THREE.Vector3(0.05, 0, -12), priority: farPriority },
    { id: "near", headPosition: new THREE.Vector3(0, 0, -6) },
  ];
  plates.update(entries(false), camera, W, H, true);
  assert.equal(element("near").style.display, "");
  assert.equal(element("far").style.display, "none");
  plates.update(entries(true), camera, W, H, true);
  assert.equal(element("far").style.display, "");
  assert.equal(element("near").style.display, "none");
});

test("a new plate starts hidden until it is placed; removing it drops its state", () => {
  const { plates, camera, element } = setup();
  plates.set("c", "c-player");
  assert.equal(element("c").style.display, "none");
  plates.update([{ id: "c", headPosition: new THREE.Vector3(0, 0, -5) }], camera, W, H);
  assert.equal(element("c").style.display, "");
  plates.remove("c");
  plates.set("c", "c-player");
  assert.equal(element("c").style.display, "none", "a re-added plate is new again");
});

test("a moderator's plate carries a small Moderator tag (text only), and it comes off again", () => {
  const { plates, element } = setup();
  plates.set("m", "m-player <b>", "Moderator");
  const plate = element("m");
  const tag = plate.querySelector(".zw-nameplate-tag");
  assert.equal(tag?.textContent, "Moderator");
  assert.equal(plate.firstChild?.textContent, "m-player <b>", "the name stays text");
  assert.equal(plate.querySelector("b"), null);
  plates.set("m", "m-player <b>", "Moderator");
  assert.equal(plate.querySelector(".zw-nameplate-tag"), tag, "an unchanged set rewrites nothing");
  plates.set("m", "m-player <b>");
  assert.equal(plate.querySelector(".zw-nameplate-tag"), null);
  assert.equal(plate.textContent, "m-player <b>");
});
