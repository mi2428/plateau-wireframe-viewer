import * as THREE from 'three';

export function fitModel(camera, controls, bounds, view = 'iso') {
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.5);
  const direction = view === 'top' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0.8, 1);
  let distance = radius * 3;
  if (camera.isPerspectiveCamera) {
    const vertical = THREE.MathUtils.degToRad(camera.fov / 2);
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.1;
  } else {
    const extent = radius * 1.1 / Math.min(camera.aspect, 1);
    camera.left = -extent * camera.aspect;
    camera.right = extent * camera.aspect;
    camera.top = extent;
    camera.bottom = -extent;
    camera.zoom = 1;
  }
  camera.near = radius / 1000;
  camera.far = distance + radius * 100;
  camera.position.copy(center).addScaledVector(direction.normalize(), distance);
  camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.minDistance = radius / 100;
  controls.maxDistance = radius * 100;
  controls.update();
}

export function createBirdOrbit(camera, target) {
  const offset = new THREE.Vector3(), spherical = new THREE.Spherical();
  const basePhi = THREE.MathUtils.clamp(spherical.setFromVector3(offset.copy(camera.position).sub(target)).phi, .55, 1.2);
  let elapsed = 0;
  camera.up.set(0, 1, 0);
  return delta => {
    const step = THREE.MathUtils.clamp(delta, 0, .05);
    elapsed += step;
    spherical.setFromVector3(offset.copy(camera.position).sub(target));
    spherical.theta += step * .28;
    spherical.phi = basePhi + .18 * Math.sin(elapsed * .7);
    camera.position.copy(target).add(offset.setFromSpherical(spherical));
  };
}
