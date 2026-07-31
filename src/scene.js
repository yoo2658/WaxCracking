import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GROUND_Y = -1.35;

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x23262e);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0.15, 4.4);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const hemi = new THREE.HemisphereLight(0xfff3e0, 0x14161b, 0.7);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 4, 5);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xbfd8ff, 0.7);
  rim.position.set(-4, -1.5, -3);
  scene.add(rim);

  // Catches fragments popped off the wax shell so they visibly land somewhere.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  scene.add(ground);

  // Dragging on the canvas orbits the camera around the (always-static) wax
  // mesh. Clicks are handled separately by PointerInteraction, which only
  // fires on pointerup-with-little-movement, so it never fights this drag.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 2.6;
  controls.maxDistance = 7;
  controls.update();

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', resize);
  resize();

  return { renderer, scene, camera, controls, groundY: GROUND_Y };
}
