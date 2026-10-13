/**
 * Travel destinations. The content provider lists them; the portal menu shows the listed ones, and doors
 * travel to a destination by id. `available` ones are arrival points the portal teleports to; the others
 * are announced future locations shown in the portal menu as "coming soon".
 */
export interface PortalDestination {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Short pictogram shown on the destination card. */
  readonly icon: string;
  readonly available: boolean;
  /** Arrival point on the ground (available destinations only). */
  readonly arrival?: { readonly x: number; readonly z: number };
  /** Point the player faces on arrival. */
  readonly lookAt?: { readonly x: number; readonly z: number };
  /** Camera pitch on arrival in degrees (positive looks down); default keeps the current pitch. */
  readonly cameraPitch?: number;
  /** False for door-only destinations that the portal menu does not list (default: listed). */
  readonly listed?: boolean;
}
