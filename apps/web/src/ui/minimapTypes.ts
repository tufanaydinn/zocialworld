/**
 * Location-agnostic map description consumed by the minimap and the
 * full map overlay. A world location (e.g. a district)
 * provides one; the UI never imports world code directly.
 * All coordinates are world meters on the XZ plane.
 */
export interface MinimapData {
  readonly title: string;
  /** Floor colour under the whole sheet (indoor maps); painted grass when absent. */
  readonly background?: string;
  readonly bounds: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
  /** Filled ground areas drawn first (paving, terraces, grass). */
  readonly areas: readonly { readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number; readonly color: string }[];
  readonly circles: readonly { readonly x: number; readonly z: number; readonly radius: number; readonly color: string }[];
  /** Building footprints (rotated rectangles). */
  readonly buildings: readonly {
    readonly x: number;
    readonly z: number;
    readonly width: number;
    readonly depth: number;
    readonly yaw: number;
    /** Roof color (CSS) — the painted map shows roofs from above. */
    readonly color?: string;
  }[];
  /** Named zones with a colored marker and an optional pictogram. */
  readonly markers: readonly {
    readonly label: string;
    readonly x: number;
    readonly z: number;
    readonly color: string;
    readonly icon?: "tavern" | "builders" | "market" | "board" | "monument" | "portal" | "stage";
  }[];
  /** Walkways drawn as light strokes (polylines, meters wide). */
  readonly paths?: readonly { readonly points: readonly (readonly [number, number])[]; readonly width: number }[];
  /** Tree canopy positions (dots). */
  readonly trees?: readonly (readonly [number, number])[];
  /** Stair runs drawn with step hatching: rectangle + direction of ascent. */
  readonly stairs?: readonly { readonly x0: number; readonly z0: number; readonly x1: number; readonly z1: number }[];
  /** Named regions for the HUD location label: the first containing the player wins. */
  readonly regions: readonly { readonly name: string; readonly x: number; readonly z: number; readonly radius: number }[];
}
