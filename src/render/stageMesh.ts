/**
 * Stage rendering.
 *
 * Builds the visible corridor from exactly the same vertex data the physics
 * collider uses, so what you drive on is what you see — no second authoring
 * step, and no chance of the two drifting apart.
 *
 * Surfaces are shown as vertex colours rather than textures: it suits the
 * flat-shaded look, it costs one buffer, and it makes a gravel-to-tarmac
 * transition a crisp visible line exactly where the grip actually changes.
 */

import * as THREE from 'three';
import type { PropKind, Stage } from '../sim/stage.js';
import { SURFACES } from '../sim/surfaces.js';

/** Slight per-vertex value jitter so large flat areas do not read as dead. */
function mottle(index: number): number {
  const n = Math.sin(index * 12.9898) * 43758.5453;
  return 1 + ((n - Math.floor(n)) - 0.5) * 0.08;
}

export interface StageView {
  group: THREE.Group;
  dispose: () => void;
}

export function buildStageView(stage: Stage): StageView {
  const group = new THREE.Group();
  const { vertices, indices, vertexSurfaces, vertexShade } = stage.geometry;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  const colors = new Float32Array(vertexSurfaces.length * 3);
  const c = new THREE.Color();
  for (let i = 0; i < vertexSurfaces.length; i++) {
    c.setHex(SURFACES[vertexSurfaces[i]!].color).multiplyScalar(mottle(i) * vertexShade[i]!);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const road = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
      flatShading: true,
    }),
  );
  road.receiveShadow = true;
  road.castShadow = true;
  group.add(road);

  group.add(buildGates(stage));
  group.add(buildEdgeMarkers(stage));
  group.add(buildProps(stage));

  return {
    group,
    dispose: () => {
      geometry.dispose();
      (road.material as THREE.Material).dispose();
    },
  };
}

/**
 * Roadside hazards.
 *
 * Instanced per kind, and deliberately chunky: at this camera distance a
 * hazard has to be unmistakable, because hitting one is expensive and the
 * player needs to have seen it coming.
 */
function buildProps(stage: Stage): THREE.Group {
  const group = new THREE.Group();
  if (stage.props.length === 0) return group;

  const byKind = new Map<PropKind, typeof stage.props>();
  for (const prop of stage.props) {
    const list = byKind.get(prop.kind) ?? [];
    list.push(prop);
    byKind.set(prop.kind, list);
  }

  const build: Record<PropKind, () => { geometry: THREE.BufferGeometry; color: number }> = {
    // Trunk plus canopy merged into one silhouette by stacking two cylinders.
    tree: () => ({ geometry: new THREE.ConeGeometry(1.5, 5.5, 6), color: 0x33512f }),
    rock: () => ({ geometry: new THREE.DodecahedronGeometry(0.95, 0), color: 0x6a6a68 }),
    bale: () => ({ geometry: new THREE.CylinderGeometry(0.75, 0.75, 1.5, 8), color: 0xb59a55 }),
    pole: () => ({ geometry: new THREE.BoxGeometry(0.22, 2.2, 0.22), color: 0xdcd6c6 }),
  };

  for (const [kind, props] of byKind) {
    const { geometry, color } = build[kind]();
    const mesh = new THREE.InstancedMesh(
      geometry,
      new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true }),
      props.length,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3(1, 1, 1);

    props.forEach((prop, i) => {
      pos.set(prop.position.x, prop.position.y + prop.height / 2, prop.position.z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), prop.yaw);
      // Rocks look wrong perfectly upright; a little tilt reads as natural.
      if (kind === 'rock') q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), prop.yaw * 0.3));
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
  }

  return group;
}

/** Start line, checkpoint gates and finish line, as paired posts plus a banner. */
function buildGates(stage: Stage): THREE.Group {
  const gates = new THREE.Group();

  const postGeo = new THREE.BoxGeometry(0.4, 3.4, 0.4);
  const make = (
    position: { x: number; y: number; z: number },
    right: { x: number; y: number; z: number },
    width: number,
    color: number,
  ) => {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, flatShading: true });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, mat);
      post.position.set(
        position.x + right.x * width * side,
        position.y + 1.7,
        position.z + right.z * width * side,
      );
      post.castShadow = true;
      gates.add(post);
    }
    // A thin banner across the top reads as a gate from the isometric angle,
    // where two separate posts do not.
    const banner = new THREE.Mesh(new THREE.BoxGeometry(width * 2, 0.5, 0.25), mat);
    banner.position.set(position.x, position.y + 3.3, position.z);
    banner.lookAt(position.x + right.x, position.y + 3.3, position.z + right.z);
    banner.rotateY(Math.PI / 2);
    gates.add(banner);
  };

  const first = stage.spline.samples[0]!;
  make(first.position, first.right, first.width, 0x4fd6a0);

  for (const cp of stage.checkpoints) make(cp.position, cp.right, cp.width, 0xf2c14e);

  const last = stage.spline.samples[stage.spline.samples.length - 1]!;
  make(last.position, last.right, last.width, 0xe8552f);

  return gates;
}

/**
 * Posts along the road edge. Purely visual, but on a fixed isometric camera
 * they are what makes the road's direction and width readable at a glance —
 * the same job real rally stage marker poles do.
 */
function buildEdgeMarkers(stage: Stage): THREE.Group {
  const spacing = 18;
  const samples = stage.spline.samples;
  const count = Math.floor(stage.length / spacing) * 2;

  const geo = new THREE.BoxGeometry(0.22, 1.1, 0.22);
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.7, flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(count, 1));
  mesh.castShadow = true;

  const m = new THREE.Matrix4();
  let n = 0;
  const step = stage.length / Math.max(samples.length - 1, 1);
  for (let d = spacing; d < stage.length && n + 1 < mesh.count; d += spacing) {
    const s = samples[Math.min(Math.round(d / step), samples.length - 1)]!;
    for (const side of [-1, 1]) {
      const off = s.width + 0.7;
      m.setPosition(
        s.position.x + s.right.x * off * side,
        s.position.y + 0.55,
        s.position.z + s.right.z * off * side,
      );
      mesh.setMatrixAt(n++, m);
    }
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.add(mesh);
  return group;
}
