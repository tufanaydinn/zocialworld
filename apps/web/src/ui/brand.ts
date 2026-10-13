/**
 * Whether this build ships the deployment's artwork under /brand/ (logo, backdrop, icons). Without it the
 * screens keep their colour gradient and text title, and no request is made for a missing image.
 */
export const HAS_BRAND_ART: boolean = import.meta.env?.VITE_BRAND === "1";

/** The CSS background layer for a brand image, or nothing when the build has no artwork. */
export function brandBackground(file: string): string {
  return HAS_BRAND_ART ? ` url("/brand/${file}") center / cover no-repeat` : "";
}
