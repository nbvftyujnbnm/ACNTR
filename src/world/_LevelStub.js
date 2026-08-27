import * as THREE from 'three';

/**
 * TEMPORARY integration stub — NOT the real level.
 *
 * The real `Level.js` is being authored concurrently. This stub exists purely so
 * the game can boot and the other ~31k lines of subsystem code can be
 * smoke-tested for integration errors in parallel, instead of everything
 * blocking on one module. Game.js points here only while that is true.
 *
 * Delete this file once Level.js lands.
 */
export class Level {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.spawnPoints = [];
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-450, -20, -450),
      new THREE.Vector3(450, 300, 450)
    );
    this.arenaRadius = 440;
    this._disposables = [];
  }

  async build() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(900, 900, 32, 32),
      new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.92, metalness: 0.05 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this._disposables.push(ground.geometry, ground.material);
    this.physics?.addStatic?.(ground);

    // A few blocks so collision, shadows and depth-based post passes have
    // something non-trivial to chew on during the smoke test.
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0x6b7076, roughness: 0.6, metalness: 0.85 });
    this._disposables.push(boxGeo, boxMat);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r = 60 + (i % 5) * 34;
      const h = 18 + (i % 7) * 16;
      const m = new THREE.Mesh(boxGeo, boxMat);
      m.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      m.scale.set(14 + (i % 4) * 6, h, 14 + (i % 3) * 8);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
      const box = new THREE.Box3().setFromObject(m);
      this.physics?.addBox?.(box);
      this.spawnPoints.push(new THREE.Vector3(Math.cos(a) * (r + 20), h + 4, Math.sin(a) * (r + 20)));
    }
    return this;
  }

  update() {}

  dispose() {
    for (const d of this._disposables) d?.dispose?.();
    this._disposables.length = 0;
  }
}
