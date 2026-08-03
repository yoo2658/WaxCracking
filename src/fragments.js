import * as THREE from 'three';

const GRAVITY = -9.8;
const MAX_FRAGMENTS = 24;
const LAND_LINGER_SECONDS = 1.0; // how long a landed fragment stays before fading
const FADE_SECONDS = 0.5;

// A flat, irregular chip — 3 to 6 sides, jittered radius — rather than a
// solid 3D chunk, so falling debris reads as a thin broken wax flake.
function buildShardGeometry(size) {
  const sides = 3 + Math.floor(Math.random() * 4);
  const shape = new THREE.Shape();
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const r = size * (0.7 + Math.random() * 0.5);
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();

  const geometry = new THREE.ShapeGeometry(shape);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Small pool of debris meshes that pop off the wax shell, tumble under
 * gravity, rest on a ground plane, then fade out and disappear after a
 * moment rather than piling up. Purely a cosmetic approximation (a flat
 * jittered polygon, not an exact cut of the shell's Voronoi cell) — good
 * enough for the "a chunk breaks off and falls" payoff without mesh boolean
 * surgery.
 */
export class FragmentSystem {
  constructor(scene, groundY) {
    this.scene = scene;
    this.groundY = groundY;
    this.items = [];
  }

  spawn(point, normal, color, size) {
    // Vary the overall chip size, not just its jagged outline — otherwise
    // every pop reads as the same uniform-sized chunk breaking off.
    const randomizedSize = size * (0.5 + Math.random() * 1.3);
    const geometry = buildShardGeometry(randomizedSize);
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0,
      side: THREE.DoubleSide, // flat plane — needs to stay visible while it tumbles edge-on
      transparent: true,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(point);
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    this.scene.add(mesh);

    const velocity = normal
      .clone()
      .multiplyScalar(1.1)
      .add(new THREE.Vector3((Math.random() - 0.5) * 1.4, Math.random() * 0.8, (Math.random() - 0.5) * 1.4));

    this.items.push({
      mesh,
      velocity,
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
      ),
      landed: false,
      landedElapsed: 0,
    });

    if (this.items.length > MAX_FRAGMENTS) {
      this._remove(this.items.shift());
    }
  }

  update(dt) {
    const survivors = [];
    for (const item of this.items) {
      if (!item.landed) {
        item.velocity.y += GRAVITY * dt;
        item.mesh.position.addScaledVector(item.velocity, dt);
        item.mesh.rotation.x += item.angularVelocity.x * dt;
        item.mesh.rotation.y += item.angularVelocity.y * dt;
        item.mesh.rotation.z += item.angularVelocity.z * dt;

        if (item.mesh.position.y <= this.groundY) {
          item.mesh.position.y = this.groundY;
          item.velocity.set(0, 0, 0);
          item.landed = true;
        }
        survivors.push(item);
        continue;
      }

      item.landedElapsed += dt;
      if (item.landedElapsed > LAND_LINGER_SECONDS) {
        const fadeT = (item.landedElapsed - LAND_LINGER_SECONDS) / FADE_SECONDS;
        if (fadeT >= 1) {
          this._remove(item);
          continue; // dropped — not pushed to survivors
        }
        item.mesh.material.opacity = 1 - fadeT;
      }
      survivors.push(item);
    }
    this.items = survivors;
  }

  reset() {
    for (const item of this.items) this._remove(item);
    this.items = [];
  }

  _remove(item) {
    this.scene.remove(item.mesh);
    item.mesh.geometry.dispose();
    item.mesh.material.dispose();
  }
}
