import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFileSource } from '../src/source.js';
import { fitModel, createBirdOrbit } from '../src/camera.js';
import { coordinateReference, localProjector } from '../src/coordinates.js';

test('2D uses a zero-elevation display plane; 3D retains source height and east/height/-north axes', () => {
  const reference = coordinateReference({ srsName: 'EPSG:4326' });
  assert.equal(reference.dimension, 2);
  assert.equal(reference.hasElevation, false);
  assert.deepEqual(reference.toGeographic([35, 135]), [135, 35, 0]);
  const plane = coordinateReference({ srsName: 'EPSG:6677', axisLabels: 'E N' });
  assert.equal(plane.toGeographic([0, 0])[2], 0);
  const elevated = coordinateReference({ srsName: 'EPSG:6697', axisLabels: 'Long Lat h' });
  assert.equal(elevated.hasElevation, true);
  assert.deepEqual(elevated.toGeographic([135, 35, -4]), [135, 35, -4]);
  const project = localProjector([135, 35, 10]);
  assert.equal(project([135, 35, -4])[1], -4);
  assert.ok(project([135.001, 35.001, 10])[0] > 0);
  assert.ok(project([135.001, 35.001, 10])[2] < 0);
  assert.throws(() => reference.toGeographic([35, 135, 0]), /dimension/);
  assert.throws(() => coordinateReference({ srsName: 'EPSG:3857' }), /Unsupported/);
  assert.throws(() => coordinateReference({ srsName: 'EPSG:4326', dimension: 4 }), /dimension/);
  assert.throws(() => coordinateReference({ srsName: 'EPSG:4326', axisLabels: 'lat h' }), /axisLabels/);
});

test('selected files only: folder identity, scope, missing references, abort, and URL cleanup', async () => {
  const file = (name, body, path = '', lastModified = 7) => {
    const result = new File([body], name, { lastModified });
    Object.defineProperty(result, 'webkitRelativePath', { value: path });
    return result;
  };
  const root = file('model.gml', 'root'), source = createFileSource(root);
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests++; throw new Error('Network must not be used for selected files.'); };
  try {
    assert.equal(await (await source.fetch(source.url)).text(), 'root');
    assert.throws(() => source.file('other.gml'), /Missing selected file/);
    for (const ref of ['https://example.org/a.gml', 'http://localhost/data/a.gml', 'file:///a.gml',
      '../escape.gml', '%2e%2e/escape.gml', 'https://selected.invalid/%2fescape', 'foo\\bar', 'model.gml?x=1']) {
      assert.throws(() => source.resolve(ref), ref);
    }
    await assert.rejects(source.selectFolder([file('model.gml', 'evil', 'package/udx/model.gml')]), /different root/);
    await assert.rejects(source.selectFolder([file('other.gml', 'root', 'unrelated/other.gml')]), /does not contain/);
    await assert.rejects(source.selectFolder([file('model.gml', 'root', 'unrelated/model.gml'), file('model.gml', 'root', 'unrelated/duplicate/model.gml', 8)]), /Duplicate matching root/);
    await assert.rejects(source.selectFolder([file('model.gml', 'root', 'package/a/model.gml'), file('model.gml', 'root', 'package/b/model.gml')]), /Duplicate matching root/);
    await source.selectFolder([
      file('model.gml', 'root', 'package/udx/model.gml', 8), // A copied package may have a different mtime.
      file('shape.gml', 'selected dependency', 'package/shape.gml'),
    ]);
    const sibling = source.resolve('../shape.gml#id');
    assert.equal(await (await source.fetch(sibling)).text(), 'selected dependency');
    assert.throws(() => source.file('../unknown.gml'), /Missing selected file/);
    assert.throws(() => source.resolve('../../outside.gml'), /escapes/);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(source.fetch(sibling, { signal: aborted.signal }), { name: 'AbortError' });
    const owned = source.objectUrl(sibling);
    assert.equal(await (await originalFetch(owned)).text(), 'selected dependency');
    source.dispose();
    await assert.rejects(originalFetch(owned));
    assert.throws(() => source.file(sibling), /closed/);
    assert.equal(requests, 0);
  } finally { source.dispose(); globalThis.fetch = originalFetch; }
});

test('orthographic fit resets zoom and centers the model', () => {
  const camera = new THREE.OrthographicCamera();
  camera.aspect = 1.5;
  camera.zoom = 4;
  const controls = { target: new THREE.Vector3(), update() {} };
  const box = new THREE.Box3(new THREE.Vector3(-5, -2, -8), new THREE.Vector3(5, 2, 8));
  fitModel(camera, controls, box);
  assert.equal(camera.zoom, 1);
  assert.ok(camera.top >= 8);
  assert.ok(controls.target.equals(new THREE.Vector3()));
  camera.aspect = 0.5;
  fitModel(camera, controls, box, 'top');
  assert.ok(camera.right >= 8);
});

test('bird orbit preserves target distance while changing azimuth and elevation smoothly', () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(10, 8, 10);
  const target = new THREE.Vector3(), before = camera.position.clone(), orbit = createBirdOrbit(camera, target);
  for (let i = 0; i < 20; i++) orbit(.05);
  assert.ok(Math.abs(camera.position.distanceTo(target) - before.distanceTo(target)) < 1e-5);
  assert.ok(Math.abs(camera.position.y - before.y) > .1);
  assert.ok(Math.abs(Math.atan2(camera.position.x, camera.position.z) - Math.atan2(before.x, before.z)) > .1);
  const stopped = camera.position.clone();
  orbit(0);
  assert.ok(camera.position.distanceTo(stopped) < 1e-5);
  camera.position.set(0, 10, 0);
  createBirdOrbit(camera, target)(.05);
  assert.ok(camera.position.y < 10, 'top view tilts gently into a fly-around path');
});
