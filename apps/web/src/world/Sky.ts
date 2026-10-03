import * as THREE from "three";

/**
 * Cheap vertical-gradient sky dome: a big inverted sphere with a vertex
 * shader that lerps between a horizon color and a zenith color. Far
 * lighter than an HDRI or a physical sky model, and enough to sell the
 * "warm dusk" mood from master spec section 52/127 without any texture
 * download.
 */
export function createSky(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(150, 24, 16);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x4a4668) },
      horizonColor: { value: new THREE.Color(0xe8a564) },
      bottomColor: { value: new THREE.Color(0x3a3240) },
      horizonHeight: { value: 0.08 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 bottomColor;
      uniform float horizonHeight;
      varying vec3 vWorldPosition;

      void main() {
        float h = normalize(vWorldPosition).y;
        vec3 color = h > horizonHeight
          ? mix(horizonColor, topColor, smoothstep(horizonHeight, 0.6, h))
          : mix(bottomColor, horizonColor, smoothstep(-0.2, horizonHeight, h));
        gl_FragColor = vec4(color, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  const sky = new THREE.Mesh(geometry, material);
  sky.name = "SkyDome";
  sky.renderOrder = -1;
  return sky;
}
