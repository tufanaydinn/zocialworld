import * as THREE from "three";
import type { HallScreenHandle } from "./contract.ts";
import { drawScreenIdle, hallTextMaterial, livePillTexture } from "./boardFaces.ts";

/**
 * The big screen's picture (WATCH_HALL.md): an unlit panel at
 * brightness 0.8 with fog off, in front of a black backing so videos with
 * another aspect ratio are letterboxed instead of stretched. The frame,
 * trim and lights around it belong to the builder.
 */
export class HallScreen implements HallScreenHandle {
  readonly anchor = new THREE.Group();
  readonly center: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly width: number;
  readonly height: number;
  private readonly picture: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly livePill: THREE.Mesh;
  private readonly idleCanvas = document.createElement("canvas");
  private readonly idleTexture: THREE.CanvasTexture;
  private texture: THREE.Texture | null = null;
  private fittedAspect = 16 / 9;
  private idleKey = "";

  /** `center` and `yaw` place the picture in world space; the picture faces +z rotated by `yaw`. */
  constructor(center: THREE.Vector3, yaw: number, width: number, height: number) {
    this.center = center.clone();
    this.normal = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this.width = width;
    this.height = height;
    this.anchor.name = "HallScreen";
    this.anchor.position.copy(center);
    this.anchor.rotation.y = yaw;

    const backing = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: 0x050407, fog: false }));
    backing.position.z = -0.005;
    this.anchor.add(backing);

    // The idle face (the ZEC emblem) is drawn at 2048 × 1152 so the emblem and its text stay crisp from the back row.
    this.idleCanvas.width = 2048;
    this.idleCanvas.height = 1152;
    this.idleTexture = new THREE.CanvasTexture(this.idleCanvas);
    this.idleTexture.colorSpace = THREE.SRGBColorSpace;
    this.setIdleMessage("Watch Hall", "Nobody on stage — request it at the podium");
    this.picture = new THREE.Mesh(new THREE.PlaneGeometry(width, height), hallTextMaterial(this.idleTexture));
    this.picture.name = "HallScreenPicture";
    this.anchor.add(this.picture);

    const pillHeight = height * 0.075;
    this.livePill = new THREE.Mesh(new THREE.PlaneGeometry(pillHeight * (256 / 96), pillHeight), hallTextMaterial(livePillTexture()));
    this.livePill.position.set(width / 2 - pillHeight * 1.9, height / 2 - pillHeight * 0.95, 0.01);
    this.livePill.visible = false;
    this.anchor.add(this.livePill);
  }

  setTexture(texture: THREE.Texture | null): void {
    if (texture && (texture as THREE.VideoTexture).isVideoTexture) {
      // A shared tab's text reaches the middle and back rows minified 2–4×. VideoTexture defaults to bilinear without
      // mipmaps, which drops glyph strokes at that scale; trilinear mipmaps plus anisotropic filtering keep
      // body text legible from the back row and the entrance. Video
      // textures are re-uploaded with texImage2D every frame, so this applies from the next frame; the cost is one
      // mip build per decoded frame.
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.anisotropy = 16;
    }
    this.texture = texture;
    this.picture.material.map = texture ?? this.idleTexture;
    this.picture.material.needsUpdate = true;
    this.fit();
  }

  setIdleMessage(title: string, subtitle: string): void {
    const key = `${title}\n${subtitle}`;
    if (key === this.idleKey) return;
    this.idleKey = key;
    drawScreenIdle(this.idleCanvas, title, subtitle);
    this.idleTexture.needsUpdate = true;
  }

  setLive(live: boolean): void {
    this.livePill.visible = live;
  }

  /** Re-fits the picture when a video's size becomes known (or changes); call once a frame while the hall is active. */
  update(): void {
    if (this.texture) this.fit();
  }

  private fit(): void {
    const image = this.texture?.image as { videoWidth?: number; videoHeight?: number; width?: number; height?: number } | undefined;
    const w = image?.videoWidth || image?.width || 16;
    const h = image?.videoHeight || image?.height || 9;
    const aspect = this.texture ? w / h : 16 / 9;
    if (Math.abs(aspect - this.fittedAspect) < 1e-3) return;
    this.fittedAspect = aspect;
    const frame = this.width / this.height;
    this.picture.scale.set(aspect >= frame ? 1 : aspect / frame, aspect >= frame ? frame / aspect : 1, 1);
  }
}
