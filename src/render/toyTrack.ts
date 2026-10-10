/**
 * Toy track: the look of a stage laid in plastic track pieces, and of the loop.
 *
 * Everything here is paint. The track is tarmac to a tyre and the corridor's
 * shape is the corridor's, so the simulation knows nothing of it — the pieces,
 * their colours, the connectors between them and the glitter are a shader on
 * the same geometry every other stage is drawn from.
 *
 * Colour comes from distance along the stage rather than from vertex colours:
 * the corridor is built two metres to a row, so a colour change written per
 * vertex smears across a row and a piece boundary reads as a gradient instead
 * of a joint. In the shader it is a crisp line wherever it falls.
 *
 * The glitter is a hash of the world position at seven-centimetre cells — about
 * three pixels on a 1080-line window at the game camera's 39 px a metre — with
 * a steady flake under it and a few in ten twinkling on their own clocks. The
 * clock is read in `onBeforeRender`, so it runs on every draw path there is:
 * live, replay and the harness seek all render, and none of them has to know.
 */

import * as THREE from 'three';

/**
 * Metres of track per piece. A real orange-track set comes in long flexible
 * lengths, and at 8 m the colours changed every half-second at speed and read
 * as stripes rather than as pieces.
 */
export const TOY_PIECE = 80;

/** The glitter colours a toy track comes in. */
const PALETTE = [0xff2d95, 0x8a3bff, 0x00c9c0, 0xffb81a, 0x6fe03a, 0xff6a1a, 0x2f6bff].map(
  (hex) => new THREE.Color(hex),
);

export interface ToyTrackOptions {
  /** Distances along the stage the booster's chevrons are painted between. */
  boost?: [number, number];
  /**
   * See-through plastic, for the loop. From a camera above, a car over the top
   * of a loop is underneath the deck, and an opaque deck hid it for the whole
   * of the part of the stage it exists for.
   */
  clear?: boolean;
}

/**
 * A material for anything built of track pieces.
 *
 * Wants two attributes on its geometry: `aAlong`, metres along the stage, and
 * `aAcross`, where the vertex sits across the section — 0 to 1 is the deck,
 * up to 1.4 the raised edge, past that the track's sides.
 */
export function toyTrackMaterial(options: ToyTrackOptions = {}): THREE.MeshStandardMaterial {
  // Satin rather than gloss: at 0.34 the sun's highlight lay across the track
  // as a white bar the width of the screen.
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.12 });
  if (options.clear) {
    material.transparent = true;
    material.opacity = 0.32;
    material.depthWrite = false;
  }
  const uniforms = {
    uToyTime: { value: 0 },
    uToyPalette: { value: PALETTE },
    uToyBoost: { value: new THREE.Vector2(...(options.boost ?? [-1, -1])) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aAlong;
        attribute float aAcross;
        varying float vToyAlong;
        varying float vToyAcross;
        varying vec3 vToyWorld;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vToyAlong = aAlong;
        vToyAcross = aAcross;
        vToyWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uToyTime;
        uniform vec3 uToyPalette[${PALETTE.length}];
        uniform vec2 uToyBoost;
        varying float vToyAlong;
        varying float vToyAcross;
        varying vec3 vToyWorld;
        float toyHash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float toyPiece = floor(vToyAlong / ${TOY_PIECE.toFixed(1)});
        vec3 toyBase = uToyPalette[0];
        for (int i = 1; i < ${PALETTE.length}; i++) {
          if (mod(toyPiece, ${PALETTE.length.toFixed(1)}) > float(i) - 0.5) toyBase = uToyPalette[i];
        }
        float toyA = abs(vToyAcross);
        vec3 toyCol = toyBase;
        // The raised edge is the piece's own colour, darker; the sides are
        // the same colour gone pale, so a corridor reads as one wide piece.
        if (toyA > 1.0) toyCol = toyBase * 0.7;
        if (toyA > 1.4) toyCol = mix(toyBase, vec3(1.0), 0.38);
        if (toyA > 2.2) toyCol = toyBase * 0.86;
        // The connector between two pieces: dark across the deck, a pale clip
        // on the sides.
        float toyF = fract(vToyAlong / ${TOY_PIECE.toFixed(1)});
        float toyJoint = step(min(toyF, 1.0 - toyF) * ${TOY_PIECE.toFixed(1)}, 0.16);
        toyCol = mix(toyCol, toyA <= 1.0 ? vec3(0.1, 0.1, 0.13) : vec3(0.93), toyJoint * 0.85);
        // The booster's chevrons, pointing the way it throws you: the tip on
        // the centreline is the furthest along, so the arms trail back from
        // it. With the sign the other way they pointed at the start line.
        if (vToyAlong > uToyBoost.x && vToyAlong < uToyBoost.y && toyA < 0.8) {
          float toyChevron = fract((vToyAlong + toyA * 2.2) / 3.0);
          if (toyChevron < 0.32) toyCol = vec3(1.0, 0.86, 0.12);
        }
        // Glitter: a flake in every cell, a few of them catching the light.
        vec3 toyCell = floor(vToyWorld * 14.0);
        float toyH = toyHash(toyCell);
        toyCol *= 0.86 + 0.28 * toyHash(toyCell + 17.0);
        diffuseColor.rgb = toyCol;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float toyTwinkle = 0.5 + 0.5 * sin(uToyTime * (1.5 + 4.0 * toyH) + toyH * 60.0);
        float toySpark = step(0.94, toyH) * pow(toyTwinkle, 8.0);
        totalEmissiveRadiance += toySpark * mix(vec3(1.0), toyCol, 0.35) * 1.3;`,
      );
  };
  // One compiled program for every toy material, whatever its uniforms say.
  material.customProgramCacheKey = () => `toy-track${options.clear ? '-clear' : ''}`;
  (material.userData as { toyUniforms?: typeof uniforms }).toyUniforms = uniforms;
  return material;
}

/** Keep a toy material's glitter moving: call from the mesh's `onBeforeRender`. */
export function tickToyTrack(material: THREE.Material): void {
  const uniforms = (material.userData as { toyUniforms?: { uToyTime: { value: number } } }).toyUniforms;
  if (uniforms) uniforms.uToyTime.value = performance.now() / 1000;
}
