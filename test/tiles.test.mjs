import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker as NodeWorker } from 'node:worker_threads';
import * as THREE from 'three';
import { loadTiles as loadSelectedTiles } from '../src/tiles.js';
import { fixtureSource } from './fixture-source.mjs';

const source = fixtureSource('http://localhost/samples/tiles/');
const loadTiles = (url, options = {}) => loadSelectedTiles(url, { source, ...options });

test('local Tiles 1.0/1.1: actual geometry, transforms, contents/LOD, codecs, URL boundary and cancellation', async t => {
  const page = 'http://localhost/';
  const previous = new Map(['window', 'location', 'self', 'ProgressEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'Worker']
    .map(key => [key, globalThis[key]]));
  const timers = new Set(), models = [], calls = [], routes = new Map();
  const actualFetch = globalThis.fetch;
  const materialDispose = THREE.Material.prototype.dispose;
  const geometryDispose = THREE.BufferGeometry.prototype.dispose;
  const releasedMaterials = [], releasedGeometries = [];
  globalThis.window = { location: { href: page } };
  globalThis.location = window.location;
  globalThis.self = globalThis;
  globalThis.ProgressEvent = class { constructor(type, data) { this.type = type; Object.assign(this, data); } };
  // Execute Three's unchanged browser Draco worker and local WASM in Node.
  globalThis.Worker = class {
    constructor(url) {
      this.ready = actualFetch(url).then(response => response.text()).then(source => {
        const bridge = `const { parentPort } = require('node:worker_threads');
          globalThis.self = globalThis;
          self.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
          parentPort.on('message', data => self.onmessage({ data }));`;
        this.worker = new NodeWorker(`${bridge}\n${source}`, { eval: true });
        this.worker.on('message', data => this.onmessage?.({ data }));
        return this.worker;
      });
    }
    postMessage(data, transfer) { this.ready.then(worker => worker.postMessage(data, transfer)); }
    terminate() { this.ready.then(worker => worker.terminate()); }
  };
  globalThis.requestAnimationFrame = callback => {
    const timer = setTimeout(() => { timers.delete(timer); callback(performance.now()); }, 0);
    timers.add(timer);
    return timer;
  };
  globalThis.cancelAnimationFrame = timer => { clearTimeout(timer); timers.delete(timer); };
  THREE.Material.prototype.dispose = function () { releasedMaterials.push(this); materialDispose.call(this); };
  THREE.BufferGeometry.prototype.dispose = function () { releasedGeometries.push(this); geometryDispose.call(this); };
  globalThis.fetch = async (input, options = {}) => {
    const value = typeof input === 'string' ? input : input.url;
    const url = new URL(value, page);
    calls.push(url.href);
    if (['data:', 'blob:'].includes(url.protocol)) return actualFetch(input, options);
    assert.equal(url.origin, new URL(page).origin, 'external URL must be rejected before fetch');
    if (['/samples/tiles/slow.json', '/samples/tiles/held.glb'].includes(url.pathname)) {
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    }
    if (routes.has(url.pathname)) {
      const value = routes.get(url.pathname);
      return new Response(value instanceof Uint8Array ? value : JSON.stringify(value));
    }
    if (url.pathname.startsWith('/decoders/')) {
      assert.ok(['/decoders/draco/draco_wasm_wrapper.js', '/decoders/draco/draco_decoder.wasm'].includes(url.pathname));
      return new Response(await readFile(new URL(`../public${url.pathname}`, import.meta.url)));
    }
    assert.ok(url.pathname.startsWith('/samples/tiles/'));
    const bytes = await readFile(new URL(`./fixtures/${url.pathname.slice('/samples/'.length)}`, import.meta.url));
    return new Response(bytes);
  };
  t.after(() => {
    for (const model of models) model.dispose();
    for (const timer of timers) clearTimeout(timer);
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
    THREE.Material.prototype.dispose = materialDispose;
    THREE.BufferGeometry.prototype.dispose = geometryDispose;
  });

  const sample = JSON.parse(await readFile(new URL('./fixtures/tiles/tileset.json', import.meta.url)));
  const gltf = JSON.parse(await readFile(new URL('./fixtures/tiles/building.gltf', import.meta.url)));
  const renderer = { getSize: target => target.set(800, 600), extensions: { has: () => false } };
  const camera = new THREE.PerspectiveCamera(45, 4 / 3, .1, 1000);
  camera.position.set(55, 45, 55);
  camera.lookAt(0, 0, 0);
  const tickUntil = async (model, condition) => {
    for (let i = 0; i < 200 && !condition(); i++) {
      model.update(camera, renderer);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(condition(), `tiles should finish loading or report an error: ${JSON.stringify(model.group.tilesRenderer.stats)}; ${calls.filter(value => !value.startsWith('data:')).join(', ')}`);
  };
  const meshes = model => {
    const result = [];
    model.group.traverse(object => { if (object.isMesh) result.push(object); });
    return result;
  };
  const controller = new AbortController(), errors = [];
  const model = await loadTiles('/samples/tiles/tileset.json', { renderer, signal: controller.signal, onError: error => errors.push(error) });
  models.push(model);
  assert.equal(model.group.tilesRenderer.manager.resolveURL('blob:http://localhost/synthetic'), 'blob:http://localhost/synthetic');
  assert.ok(model.bounds.getCenter(new THREE.Vector3()).length() < 1e-6);
  const size = model.bounds.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - 42) < 1e-5 && Math.abs(size.y - 12) < 1e-5 && Math.abs(size.z - 8) < 1e-5);
  const up = new THREE.Vector3(0, 0, 1).transformDirection(new THREE.Matrix4().fromArray(sample.root.transform))
    .transformDirection(model.group.matrix);
  assert.ok(up.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6);
  await tickUntil(model, () => meshes(model).length === 2);
  assert.deepEqual(errors, []);
  for (const mesh of meshes(model)) {
    assert.ok(mesh.material.isMeshBasicMaterial && mesh.material.wireframe);
    assert.equal(mesh.material.color.getHex(), 0xa7b4be);
    assert.ok(model.bounds.clone().expandByScalar(1e-5).containsBox(new THREE.Box3().setFromObject(mesh)));
  }
  const beforeThemeGeometry = meshes(model).map(mesh => mesh.geometry), beforeThemeCalls = calls.length, beforeThemeBounds = model.bounds.clone();
  model.setTheme('light');
  assert.ok(meshes(model).every(mesh => mesh.material.color.getHex() === 0x4e5b68));
  assert.deepEqual(meshes(model).map(mesh => mesh.geometry), beforeThemeGeometry);
  assert.ok(model.bounds.equals(beforeThemeBounds));
  assert.equal(calls.length, beforeThemeCalls);
  model.setTheme('dark');
  assert.ok(releasedMaterials.some(material => material.isMeshStandardMaterial), 'original GLTF materials are released');
  const ortho = new THREE.OrthographicCamera(-50, 50, 50, -50, .1, 1000);
  ortho.position.copy(camera.position); ortho.lookAt(0, 0, 0);
  model.update(ortho, renderer);
  assert.deepEqual(model.group.tilesRenderer.cameras, [ortho]);
  new THREE.Scene().add(model.group);
  controller.abort();
  assert.equal(model.group.parent, null);
  assert.equal(model.group.children.length, 0);
  assert.ok(releasedGeometries.length >= 2);
  model.dispose();

  const direct = structuredClone(sample);
  direct.root.children = [direct.root.children[0]];
  direct.root.children[0].content.uri = 'building.glb';
  routes.set('/samples/tiles/glb.json', direct);
  const binaryModel = await loadTiles('/samples/tiles/glb.json', { renderer });
  models.push(binaryModel);
  await tickUntil(binaryModel, () => meshes(binaryModel).length === 1);
  binaryModel.dispose();

  const objects = (model, kind) => {
    const result = [];
    model.group.traverse(object => { if (object[kind]) result.push(object); });
    return result;
  };
  const open = async (name, condition, options = {}) => {
    const failures = [];
    const result = await loadTiles(`/samples/tiles/${name}-tileset.json`, { renderer, onError: error => failures.push(error), ...options });
    models.push(result);
    await tickUntil(result, () => failures.length || condition(result));
    assert.deepEqual(failures, [], name);
    return result;
  };
  const pnts = await open('pnts', model => objects(model, 'isPoints').length === 1);
  const cloud = objects(pnts, 'isPoints')[0];
  assert.equal(cloud.geometry.attributes.position.count, 3);
  assert.equal(cloud.material.size, 2);
  assert.equal(cloud.material.sizeAttenuation, false);
  assert.equal(cloud.material.vertexColors, Boolean(cloud.geometry.getAttribute('color')));
  if (cloud.geometry.hasAttribute('color')) {
    const rgb = [...cloud.geometry.attributes.color.array];
    pnts.setTheme('light');
    assert.equal(cloud.material.color.getHex(), 0xffffff);
    assert.deepEqual([...cloud.geometry.attributes.color.array], rgb);
  }
  assert.equal(cloud.geometry.index, null, 'points must not become triangles');
  assert.deepEqual(Array.from(cloud.geometry.attributes.position.array), [-2, 0, 0, 0, 1, 0, 2, 2, 0]);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(cloud.matrixWorld).distanceTo(new THREE.Vector3(0, -3, 0)) < 1e-5, 'RTC_CENTER placement');
  pnts.dispose();

  // A synthetic RGB pnts verifies the actual loader -> styled Points path, not just a colored BufferAttribute mock.
  const rgb = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  const featureJson = Buffer.from(JSON.stringify({ POINTS_LENGTH: 3, POSITION: { byteOffset: 0 }, RGB: { byteOffset: 40 } }));
  const featureTable = Buffer.concat([featureJson, Buffer.alloc((8 - (28 + featureJson.length) % 8) % 8, 0x20)]);
  const featureBinary = Buffer.concat([Buffer.from(new Float32Array([-2, 0, 0, 0, 1, 0, 2, 2, 0]).buffer), Buffer.alloc(4), rgb, Buffer.alloc(7)]);
  const rgbHeader = Buffer.alloc(28);
  rgbHeader.write('pnts'); rgbHeader.writeUInt32LE(1, 4);
  rgbHeader.writeUInt32LE(rgbHeader.length + featureTable.length + featureBinary.length, 8);
  rgbHeader.writeUInt32LE(featureTable.length, 12); rgbHeader.writeUInt32LE(featureBinary.length, 16);
  routes.set('/samples/tiles/rgb.pnts', Buffer.concat([rgbHeader, featureTable, featureBinary]));
  const rgbTileset = JSON.parse(await readFile(new URL('./fixtures/tiles/pnts-tileset.json', import.meta.url)));
  rgbTileset.root.content.uri = 'rgb.pnts';
  routes.set('/samples/tiles/rgb-tileset.json', rgbTileset);
  const rgbModel = await open('rgb', model => objects(model, 'isPoints').length === 1);
  const rgbPoints = objects(rgbModel, 'isPoints')[0];
  const sourceRgb = [...rgbPoints.geometry.attributes.color.array];
  assert.deepEqual(sourceRgb, [...rgb]);
  assert.equal(rgbPoints.material.vertexColors, true);
  for (const theme of ['light', 'dark']) {
    rgbModel.setTheme(theme);
    assert.equal(rgbPoints.material.color.getHex(), 0xffffff);
    assert.deepEqual([...rgbPoints.geometry.attributes.color.array], sourceRgb);
  }
  rgbModel.dispose();

  for (const name of ['i3dm', 'external-i3dm']) {
    const result = await open(name, model => meshes(model).length === 2);
    const [mesh, second] = meshes(result);
    assert.ok(mesh.material.wireframe);
    assert.equal(mesh.geometry.attributes.position.count, 8);
    const pa = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const pb = new THREE.Vector3().setFromMatrixPosition(second.matrixWorld);
    assert.ok(pa.distanceTo(new THREE.Vector3(-10, -3, 0)) < 1e-5);
    assert.ok(pb.distanceTo(new THREE.Vector3(10, -3, 0)) < 1e-5);
    assert.equal(mesh.geometry, second.geometry, 'instance scenes share decoded geometry');
    const before = releasedGeometries.filter(value => value === mesh.geometry).length;
    result.dispose(); assert.equal(releasedGeometries.filter(value => value === mesh.geometry).length, before + 1, 'shared instance geometry released once');
  }

  for (const [name, meshCount, pointCount] of [['cmpt', 3, 1], ['nested-cmpt', 3, 2], ['multiple', 3, 1], ['nested', 3, 1]]) {
    const result = await open(name, model => meshes(model).length === meshCount && objects(model, 'isPoints').length === pointCount);
    const owner = meshes(result)[0].userData.tile;
    for (const object of [...meshes(result), ...objects(result, 'isPoints')]) {
      assert.equal(object.userData.tile, owner, 'all contents have one tile owner and LOD');
    }
    assert.equal(result.group.children.length, 1, 'all contents become visible together');
    for (const object of objects(result, 'isPoints')) assert.equal(object.material.size, 2);
    result.dispose();
  }

  const implicit = await open('implicit', model => objects(model, 'isPoints').length === 5 && meshes(model).length === 3);
  implicit.setTheme('light');
  assert.ok(meshes(implicit).every(mesh => mesh.material.color.getHex() === 0x4e5b68));
  assert.equal(objects(implicit, 'isPoints').reduce((count, object) => count + object.geometry.attributes.position.count, 0), 15);
  assert.ok(calls.includes(`${page}samples/tiles/implicit-availability.bin`), 'external local subtree buffer decoded');
  const pointCenters = objects(implicit, 'isPoints').map(object => new THREE.Vector3().setFromMatrixPosition(object.matrixWorld).toArray().map(value => Math.round(value) + 0)).sort();
  assert.deepEqual(pointCenters, [[-15, -3, -15], [-15, -3, 15], [0, -3, 0], [15, -3, -15], [15, -3, 15]].sort());
  implicit.group.tilesRenderer.lruCache.remove(implicit.group.tilesRenderer.root);
  assert.equal(implicit.group.children.length, 0, 'subtree eviction removes every generated content, without orphaned scenes');
  await tickUntil(implicit, () => objects(implicit, 'isPoints').length === 5 && meshes(implicit).length === 3);
  assert.ok(meshes(implicit).every(mesh => mesh.material.color.getHex() === 0x4e5b68), 'future Tiles content uses current theme');
  implicit.dispose();

  const chained = JSON.parse(await readFile(new URL('./fixtures/tiles/implicit-tileset.json', import.meta.url)));
  chained.root.contents = [chained.root.contents[0]];
  chained.root.implicitTiling.subtreeLevels = 1;
  chained.root.implicitTiling.subtrees.uri = 'chain-{level}-{x}-{y}.json';
  routes.set('/samples/tiles/chained-tileset.json', chained);
  routes.set('/samples/tiles/chain-0-0-0.json', {
    buffers: [{ byteLength: 1, uri: 'chain-availability.bin' }], bufferViews: [{ buffer: 0, byteLength: 1 }],
    tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }], childSubtreeAvailability: { bitstream: 0 },
  });
  routes.set('/samples/tiles/chain-availability.bin', Buffer.from([1]));
  routes.set('/samples/tiles/chain-1-0-0.json', { tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }], childSubtreeAvailability: { constant: 0 } });
  const childSubtree = await open('chained', model => objects(model, 'isPoints').length === 2);
  assert.ok(calls.includes(`${page}samples/tiles/chain-1-0-0.json`), 'JSON child subtree loaded');
  childSubtree.dispose();
  const octree = structuredClone(chained);
  octree.root.implicitTiling.subdivisionScheme = 'OCTREE';
  octree.root.implicitTiling.availableLevels = 1;
  octree.root.implicitTiling.subtrees.uri = 'octree.json';
  routes.set('/samples/tiles/octree-tileset.json', octree);
  routes.set('/samples/tiles/octree.json', { tileAvailability: { constant: 1 }, contentAvailability: [{ constant: 1 }], childSubtreeAvailability: { constant: 0 } });
  (await open('octree', model => objects(model, 'isPoints').length === 1)).dispose();

  const topology = await open('topology', model => meshes(model).length === 3 && objects(model, 'isLine').length === 3 && objects(model, 'isPoints').length === 1);
  const colorMesh = meshes(topology)[0], colorLine = objects(topology, 'isLine')[0];
  for (const object of [colorMesh, colorLine]) {
    object.geometry.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(object.geometry.attributes.position.count * 3).fill(255), 3, true));
    assert.equal(object.material.vertexColors, false); // Mesh/Line wire style ignores COLOR_0.
  }
  for (const [theme, color] of [['light', 0x4e5b68], ['dark', 0xa7b4be]]) {
    topology.setTheme(theme);
    assert.equal(colorMesh.material.color.getHex(), color);
    assert.equal(colorLine.material.color.getHex(), color);
  }
  assert.deepEqual(objects(topology, 'isLine').map(object => object.type).sort(), ['Line', 'LineLoop', 'LineSegments']);
  for (const object of objects(topology, 'isLine')) assert.ok(object.material.isLineBasicMaterial);
  assert.equal(objects(topology, 'isPoints')[0].geometry.attributes.position.count, 6);
  assert.deepEqual(meshes(topology).map(mesh => mesh.geometry.index?.count ?? null), [null, 12, 12], 'triangle strip/fan topology retained by GLTFLoader');
  topology.dispose();
  const deformed = await open('skin-instances', model => objects(model, 'isSkinnedMesh').length === 1 && objects(model, 'isInstancedMesh').length === 1);
  const skin = objects(deformed, 'isSkinnedMesh')[0], instance = objects(deformed, 'isInstancedMesh')[0];
  assert.equal(skin.skeleton.bones.length, 1); assert.ok(skin.geometry.attributes.skinWeight);
  assert.ok(skin.material.wireframe && instance.material.wireframe);
  assert.equal(instance.count, 2);
  skin.skeleton.computeBoneTexture(); const texture = skin.skeleton.boneTexture;
  let boneDisposed = false; texture.addEventListener('dispose', () => { boneDisposed = true; });
  deformed.dispose(); assert.ok(boneDisposed, 'skin bone texture released');

  for (const name of ['meshopt', 'draco', 'draco-pnts']) {
    const isPoint = name === 'draco-pnts';
    const result = await open(name, model => objects(model, isPoint ? 'isPoints' : 'isMesh').length === 1);
    const object = objects(result, isPoint ? 'isPoints' : 'isMesh')[0], position = object.geometry.attributes.position;
    assert.equal(position.count, 3, `${name}: actual decoded position count`);
    object.geometry.computeBoundingBox();
    const expected = isPoint ? new THREE.Box3(new THREE.Vector3(-2, 0, 0), new THREE.Vector3(2, 2, 0))
      : new THREE.Box3(new THREE.Vector3(-.5, 0, -.5), new THREE.Vector3(.5, 1, .5));
    assert.ok(object.geometry.boundingBox.min.distanceTo(expected.min) < .001);
    assert.ok(object.geometry.boundingBox.max.distanceTo(expected.max) < .001);
    if (isPoint) assert.equal(object.geometry.index, null); else if (name === 'draco') assert.equal(object.geometry.index.count, 3);
    result.dispose();
  }

  // REPLACE chooses the whole parent/child tile, not independent content leaves.
  const lod = JSON.parse(await readFile(new URL('./fixtures/tiles/multiple-tileset.json', import.meta.url)));
  lod.root.refine = 'REPLACE'; lod.root.geometricError = 8;
  lod.root.children = [{ boundingVolume: lod.root.boundingVolume, geometricError: 0,
    contents: [{ uri: 'points.pnts' }, { uri: 'building.glb' }],
    transform: new THREE.Matrix4().makeTranslation(4, 0, 0).toArray() }];
  routes.set('/samples/tiles/lod-tileset.json', lod);
  camera.position.set(500, 500, 500); camera.lookAt(0, 0, 0);
  const refined = await open('lod', model => meshes(model).length === 3 && objects(model, 'isPoints').length === 1);
  assert.equal(meshes(refined)[0].userData.tile, refined.group.tilesRenderer.root);
  camera.position.set(55, 45, 55); camera.lookAt(0, 0, 0);
  await tickUntil(refined, () => meshes(refined).length === 1 && objects(refined, 'isPoints').length === 1);
  assert.equal(meshes(refined)[0].userData.tile, refined.group.tilesRenderer.root.children[0]);
  assert.equal(objects(refined, 'isPoints')[0].userData.tile, meshes(refined)[0].userData.tile);
  camera.position.set(500, 500, 500); camera.lookAt(0, 0, 0);
  await tickUntil(refined, () => meshes(refined).length === 3);
  refined.dispose(); camera.position.set(55, 45, 55); camera.lookAt(0, 0, 0);

  const affine = structuredClone(lod);
  affine.root.children = [];
  const transform = new THREE.Matrix4().makeScale(2, 3, 4); transform.elements[4] = .5;
  affine.root.transform = transform.toArray();
  routes.set('/samples/tiles/affine-tileset.json', affine);
  const transformed = await open('affine', model => meshes(model).length === 3 && objects(model, 'isPoints').length === 1);
  const affineTiles = transformed.group.tilesRenderer, affineRoot = affineTiles.root;
  assert.ok(affineRoot.engineData.scene.matrix.equals(transform), 'aggregate preserves the complete affine tile transform once');
  const view = {}; affineTiles.calculateTileViewError(affineRoot, view);
  const info = affineTiles.cameraInfo[0], distance = affineRoot.engineData.boundingVolume.distanceToPoint(info.position);
  assert.ok(Math.abs(view.error - affineRoot.geometricError * transform.getMaxScaleOnAxis() / (distance * info.sseDenominator)) < 1e-8, 'scaled geometricError used for LOD');
  transformed.dispose();

  const held = structuredClone(lod); held.root.children = [];
  held.root.contents = [{ uri: 'points.pnts' }, { uri: 'held.glb' }];
  routes.set('/samples/tiles/held-tileset.json', held);
  const heldController = new AbortController();
  const heldModel = await loadTiles('/samples/tiles/held-tileset.json', { renderer, signal: heldController.signal });
  models.push(heldModel);
  await tickUntil(heldModel, () => calls.includes(`${page}samples/tiles/held.glb`));
  assert.equal(heldModel.group.children.length, 0, 'no partial content is published while its sibling loads');
  const releasedBeforeCancel = releasedGeometries.length;
  heldController.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(heldModel.group.children.length, 0);
  assert.equal(releasedGeometries.length, releasedBeforeCancel, 'classification waits for all sibling bytes before allocating geometry');

  const externalBytes = Buffer.from(await readFile(new URL('./fixtures/tiles/external-instances.i3dm', import.meta.url)));
  const glbOffset = 32 + [12, 16, 20, 24].reduce((sum, offset) => sum + externalBytes.readUInt32LE(offset), 0);
  const morph = structuredClone(gltf); morph.meshes[0].weights = [1]; morph.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
  routes.set('/samples/tiles/morph.gltf', morph);
  const gltfRtc = structuredClone(gltf); gltfRtc.extensionsUsed = ['CESIUM_RTC']; gltfRtc.extensions = { CESIUM_RTC: { center: [3, 4, 5] } };
  routes.set('/samples/tiles/gltf-rtc.gltf', gltfRtc);
  for (const [name, uri, expected] of [
    ['i3dm-topology', 'topology.glb', 6], ['i3dm-skin', 'skin-instances.glb', 4],
    ['i3dm-morph', 'morph.gltf', 2],
    ['i3dm-rtc', 'gltf-rtc.gltf', 2],
    ['i3dm-outside', 'https://outside.invalid/instance.glb', null],
  ]) {
    const uriBytes = Buffer.from(uri), body = Buffer.concat([uriBytes, Buffer.alloc((8 - uriBytes.length % 8) % 8, 0x20)]);
    const bytes = Buffer.concat([externalBytes.subarray(0, glbOffset), body]); bytes.writeUInt32LE(bytes.length, 8);
    routes.set(`/samples/tiles/${name}.i3dm`, bytes);
    const root = structuredClone(lod); delete root.root.contents; root.root.children = []; root.root.content = { uri: `${name}.i3dm` };
    routes.set(`/samples/tiles/${name}-tileset.json`, root);
    const failures = [];
    const result = await loadTiles(`/samples/tiles/${name}-tileset.json`, { renderer, onError: error => failures.push(error) });
    models.push(result);
    await tickUntil(result, () => failures.length || (expected && meshes(result).length === expected));
    if (!expected) { assert.match(failures[0].message, /External URLs/); assert.equal(result.group.children.length, 0); continue; }
    assert.deepEqual(failures, []);
    if (name === 'i3dm-topology') {
      assert.equal(objects(result, 'isPoints').length, 2);
      assert.equal(objects(result, 'isLine').length, 6);
      assert.equal(objects(result, 'isPoints')[0].geometry.attributes.position.count, 6);
      assert.ok(new THREE.Vector3().setFromMatrixPosition(objects(result, 'isPoints')[0].matrixWorld).distanceTo(new THREE.Vector3(-10, -3, 0)) < 1e-5);
    } else if (name === 'i3dm-skin') {
      const skins = objects(result, 'isSkinnedMesh'), instances = objects(result, 'isInstancedMesh');
      assert.equal(skins.length, 2); assert.equal(instances.length, 2);
      assert.notEqual(skins[0].skeleton.bones[0], skins[1].skeleton.bones[0], 'independent cloned skeletons');
      skins[0].skeleton.bones[0].position.y = 2;
      result.group.tilesRenderer.root.engineData.scene.updateMatrixWorld(true);
      assert.ok(skins[0].getVertexPosition(0, new THREE.Vector3()).y > 1.9);
      assert.ok(Math.abs(skins[1].getVertexPosition(0, new THREE.Vector3()).y) < 1e-6);
      const locations = instances.flatMap(instance => [0, 1].map(index => {
        const matrix = new THREE.Matrix4(); instance.getMatrixAt(index, matrix);
        return new THREE.Vector3().setFromMatrixPosition(matrix).applyMatrix4(instance.matrixWorld).x;
      })).sort((a, b) => a - b);
      assert.deepEqual(locations, [-13, -7, 7, 13], 'nested GPU instance placement');
    } else if (name === 'i3dm-morph') {
      const mesh = meshes(result)[0];
      assert.deepEqual(mesh.morphTargetInfluences, [1]);
      assert.ok(mesh.getVertexPosition(0, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).distanceTo(new THREE.Vector3(-20, -3, -8)) < 1e-5, 'morph weight affects actual vertices');
    } else {
      assert.ok(new THREE.Vector3().setFromMatrixPosition(meshes(result)[0].matrixWorld).distanceTo(new THREE.Vector3(-7, 2, -4)) < 1e-5, 'glTF CESIUM_RTC stays outside instance/axis correction');
    }
    result.dispose();
  }
  const empty = await open('i3dm-empty', model => model.group.tilesRenderer.root.engineData.scene);
  assert.equal(meshes(empty).length, 0); empty.dispose();

  const table = await open('i3dm-table', model => meshes(model).length === 2);
  const vertices = meshes(table).map(mesh => mesh.getVertexPosition(2, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
  assert.ok(vertices[0].distanceTo(new THREE.Vector3(-8, -4, 3)) < .001, 'quantized + oct normal + RTC + nonuniform scale placement');
  assert.ok(vertices[1].distanceTo(new THREE.Vector3(12, -4, 2)) < .001, 'uniform and nonuniform scale compose before glTF node geometry');
  table.dispose();

  for (const name of ['i3dm-enu', 'i3dm-enu-normals']) {
    const root = JSON.parse(await readFile(new URL(`./fixtures/tiles/${name}-tileset.json`, import.meta.url)));
    const cumulative = new THREE.Matrix4().fromArray(root.root.transform).multiply(new THREE.Matrix4().fromArray(root.root.children[0].transform));
    const result = await open(name, model => meshes(model).length === 1 && objects(model, 'isPoints').length === 1);
    const mesh = meshes(result)[0];
    const toEcef = new THREE.Matrix4().copy(result.group.matrixWorld).invert().multiply(mesh.matrixWorld);
    const expectedPosition = new THREE.Vector3(17, 16, 16).applyMatrix4(cumulative); // POSITION + RTC_CENTER, before parent×child
    assert.ok(new THREE.Vector3().setFromMatrixPosition(toEcef).distanceTo(expectedPosition) < 1e-7, 'parent transform + child transform + RTC are applied once');
    const actualUp = new THREE.Vector3(0, 1, 0).transformDirection(toEcef);
    const ellipsoid = result.group.tilesRenderer.ellipsoid;
    const surface = ellipsoid.getPositionToSurfacePoint(expectedPosition, new THREE.Vector3());
    const expectedUp = ellipsoid.getPositionToNormal(surface, new THREE.Vector3());
    if (name === 'i3dm-enu') {
      assert.ok(actualUp.distanceTo(expectedUp) < 1e-10, 'glTF Y→Z then transform-aware ENU points up at final ECEF position');
      const scale = new THREE.Vector3(0, 1, 0).applyMatrix4(toEcef).sub(new THREE.Vector3().setFromMatrixPosition(toEcef)).length();
      assert.ok(scale > 1.9 && scale < 4.1, 'ENU compensation preserves nonuniform parent scale');
    } else {
      // Cesium's custom basis is [right, up, right×up]; these normals form I.
      // Therefore the final product is cumulative × Y→Z × glTF node, not ENU.
      const reference = cumulative.clone().multiply(new THREE.Matrix4().makeTranslation(17, 16, 16)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
      assert.ok(actualUp.distanceTo(new THREE.Vector3(0, 1, 0).transformDirection(reference)) < 1e-10, 'NORMAL_UP/RIGHT overrides ENU and keeps Y→Z order');
      assert.ok(actualUp.distanceTo(expectedUp) > .1, 'custom orientation must not be replaced by automatic ENU');
    }
    result.dispose();
  }

  for (const name of ['extensionless-glb', 'extensionless-gltf', 'extensionless-nested']) {
    const result = await open(name, model => meshes(model).length === 1);
    assert.equal(meshes(result)[0].geometry.attributes.position.count, 8);
    result.dispose();
  }
  const gltfJson = structuredClone(direct); gltfJson.root.children[0].content.uri = 'geometry.json';
  routes.set('/samples/tiles/json-gltf-tileset.json', gltfJson); routes.set('/samples/tiles/geometry.json', gltf);
  (await open('json-gltf', model => meshes(model).length === 1)).dispose();
  const embedded = await open('embedded', model => meshes(model).length === 2 && objects(model, 'isPoints').length === 1);
  assert.equal(objects(embedded, 'isPoints')[0].geometry.attributes.position.count, 3);
  for (const object of [...meshes(embedded), ...objects(embedded, 'isPoints')]) assert.equal(object.userData.tile.internal.renderer, embedded.group.tilesRenderer);
  assert.equal(objects(embedded, 'isPoints')[0].material.size, 2);
  embedded.dispose();
  await assert.rejects(loadTiles('data:application/json,%7B%7D', { renderer }), /External URLs/);

  camera.position.set(500, 500, 500); camera.lookAt(0, 0, 0);
  const external = await open('external-multiple', model => meshes(model).length === 2 && objects(model, 'isPoints').length === 1);
  const externalTiles = external.group.tilesRenderer, externalRoot = externalTiles.root;
  assert.equal(externalRoot.children.length, 3, 'two external roots and a simultaneous renderable content branch');
  for (const root of externalRoot.children) assert.equal(root.externalContentOwner, externalRoot);
  assert.ok(new THREE.Vector3().setFromMatrixPosition(meshes(external).find(mesh => mesh.geometry.attributes.position.count === 8).matrixWorld)
    .distanceTo(new THREE.Vector3(0, -6, 12)) < 1e-5, 'parent × external-root transform exactly once');
  camera.position.set(55, 45, 55); camera.lookAt(0, 0, 0);
  await tickUntil(external, () => meshes(external).length === 4 && objects(external, 'isPoints').length === 2);
  for (const point of objects(external, 'isPoints')) {
    const expected = point.geometry.attributes.position.count === 3 ? new THREE.Vector3(0, 1, -12) : new THREE.Vector3(0, -2, 12);
    assert.ok(new THREE.Vector3().setFromMatrixPosition(point.matrixWorld).distanceTo(expected) < 1e-5, 'external-child transform and data pnts RTC placement');
    assert.equal(point.userData.tile.internal.renderer, externalTiles, 'one engine owns all external hierarchies');
    assert.equal(point.userData.tile.externalContentOwner, externalRoot);
  }
  camera.position.set(500, 500, 500); camera.lookAt(0, 0, 0);
  await tickUntil(external, () => meshes(external).length === 2 && objects(external, 'isPoints').length === 1);
  externalTiles.lruCache.remove(externalRoot);
  assert.equal(external.group.children.length, 0, 'external ownership eviction removes every branch');
  await tickUntil(external, () => meshes(external).length === 2 && objects(external, 'isPoints').length === 1);
  external.dispose();
  const joint = await open('external-joint', model => meshes(model).length === 1);
  assert.equal(meshes(joint)[0].userData.tile, joint.group.tilesRenderer.root);
  camera.position.set(55, 45, 55); camera.lookAt(0, 0, 0);
  await tickUntil(joint, () => meshes(joint).length === 4 && objects(joint, 'isPoints').length === 2);
  assert.equal(joint.group.tilesRenderer.root.children[0].children.length, 3);
  assert.ok(meshes(joint).every(mesh => mesh.userData.tile !== joint.group.tilesRenderer.root), 'all external contents share the parent REPLACE frontier');
  camera.position.set(500, 500, 500); camera.lookAt(0, 0, 0);
  await tickUntil(joint, () => meshes(joint).length === 1 && objects(joint, 'isPoints').length === 0);
  assert.equal(meshes(joint)[0].userData.tile, joint.group.tilesRenderer.root);
  joint.dispose(); camera.position.set(55, 45, 55); camera.lookAt(0, 0, 0);

  const externalSample = JSON.parse(await readFile(new URL('./fixtures/tiles/external-multiple-tileset.json', import.meta.url)));
  const jsonBytes = value => `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`;
  for (const [name, root, message] of [
    ['external-children', { ...structuredClone(externalSample), root: { ...structuredClone(externalSample.root), children: [{ boundingVolume: externalSample.root.boundingVolume, geometricError: 0, content: { uri: 'building.glb' } }] } }, /children/],
    ['cycle', { ...structuredClone(externalSample), root: { ...structuredClone(externalSample.root), contents: [{ uri: 'cycle-tileset.json' }] } }, /Cyclic/],
    ['data-outside', { ...structuredClone(externalSample), root: { ...structuredClone(externalSample.root), contents: [{ uri: jsonBytes({ asset: { version: '1.1' }, root: { boundingVolume: externalSample.root.boundingVolume, geometricError: 0, content: { uri: 'https://outside.invalid/inside-data.glb' } } }) }] } }, /External URLs/],
  ]) {
    routes.set(`/samples/tiles/${name}-tileset.json`, root);
    const failures = [];
    const result = await loadTiles(`/samples/tiles/${name}-tileset.json`, { renderer, onError: error => failures.push(error) });
    models.push(result); await tickUntil(result, () => failures.length);
    assert.match(failures[0].message, message); assert.equal(result.group.children.length, 0);
  }

  for (const [name, change, message] of [
    ['future', root => { root.asset.version = '1.2'; }, /version/],
    ['required', root => { root.extensionsRequired = ['UNKNOWN_geometry']; }, /required extension/],
    ['external-second', root => { root.root.contents[1].uri = 'https://outside.invalid/second.glb'; }, /External URLs/],
  ]) {
    const bad = structuredClone(lod); change(bad); routes.set(`/samples/tiles/${name}.json`, bad);
    await assert.rejects(loadTiles(`/samples/tiles/${name}.json`, { renderer }), message);
  }
  const badImplicit = JSON.parse(await readFile(new URL('./fixtures/tiles/implicit-tileset.json', import.meta.url)));
  badImplicit.root.implicitTiling.subtrees.uri = 'external-availability.subtree';
  routes.set('/samples/tiles/external-subtree-tileset.json', badImplicit);
  const subtreeBytes = Buffer.from(await readFile(new URL('./fixtures/tiles/implicit-0-0-0.subtree', import.meta.url)));
  const subtreeJson = JSON.parse(subtreeBytes.subarray(24, 24 + Number(subtreeBytes.readBigUInt64LE(8))));
  subtreeJson.buffers[0].uri = 'https://outside.invalid/availability.bin';
  const text = Buffer.from(JSON.stringify(subtreeJson)), header = Buffer.alloc(24);
  header.write('subt'); header.writeUInt32LE(1, 4); header.writeBigUInt64LE(BigInt(text.length), 8);
  routes.set('/samples/tiles/external-availability.subtree', Buffer.concat([header, text]));
  const subtreeErrors = [];
  const rejectedSubtree = await loadTiles('/samples/tiles/external-subtree-tileset.json', { renderer, onError: error => subtreeErrors.push(error) });
  models.push(rejectedSubtree);
  await tickUntil(rejectedSubtree, () => subtreeErrors.length);
  assert.match(subtreeErrors[0].message, /External URLs/);
  assert.equal(rejectedSubtree.group.children.length, 0);

  for (const [kind, volume] of [
    ['sphere', { sphere: [0, 0, 6, 24] }],
    ['region', { region: [139 * Math.PI / 180, 35 * Math.PI / 180, 139.0001 * Math.PI / 180, 35.0001 * Math.PI / 180, 0, 12] }],
  ]) {
    const root = structuredClone(sample);
    root.root.boundingVolume = volume;
    root.root.children = [];
    routes.set(`/samples/tiles/${kind}.json`, root);
    const bounded = await loadTiles(`/samples/tiles/${kind}.json`);
    models.push(bounded);
    assert.ok(bounded.bounds.getCenter(new THREE.Vector3()).length() < 1e-6);
    assert.ok(bounded.bounds.getSize(new THREE.Vector3()).length() > 0);
    bounded.dispose();
  }

  const before = calls.length;
  await assert.rejects(loadTiles('https://outside.invalid/tileset.json'), /External URLs/);
  assert.equal(calls.length, before);
  for (const kind of ['tile', 'buffer', 'image', 'ktx']) {
    const bad = structuredClone(direct);
    bad.root.children[0].content.uri = kind === 'tile' ? 'https://outside.invalid/tile.glb' : `${kind}.gltf`;
    const badGltf = structuredClone(gltf);
    if (kind === 'buffer') badGltf.buffers[0].uri = 'https://outside.invalid/geometry.bin';
    if (kind === 'image' || kind === 'ktx') {
      badGltf.images = [{ uri: 'https://outside.invalid/texture.png' }];
      badGltf.textures = [{ source: 0 }];
      badGltf.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
      if (kind === 'ktx') {
        badGltf.extensionsUsed = ['KHR_texture_basisu'];
        badGltf.images[0].uri = 'https://outside.invalid/texture.ktx2';
        badGltf.textures[0] = { extensions: { KHR_texture_basisu: { source: 0 } } };
      }
    }
    routes.set(`/samples/tiles/${kind}.json`, bad);
    routes.set(`/samples/tiles/${kind}.gltf`, badGltf);
    const failures = [];
    if (kind === 'tile') {
      await assert.rejects(loadTiles(`/samples/tiles/${kind}.json`, { renderer }), /External URLs/);
      continue;
    }
    const rejected = await loadTiles(`/samples/tiles/${kind}.json`, { renderer, onError: error => failures.push(error) });
    models.push(rejected);
    await tickUntil(rejected, () => failures.length > 0);
    assert.match(failures[0].message, /External URLs/);
    assert.equal(rejected.group.children.length, 0);
  }
  const cancel = new AbortController();
  const loading = loadTiles('/samples/tiles/slow.json', { signal: cancel.signal });
  cancel.abort();
  await assert.rejects(loading, { name: 'AbortError' });
  await assert.rejects(loadTiles('/samples/tiles/tileset.json', { signal: cancel.signal }), { name: 'AbortError' });
  assert.ok(calls.every(value => value.startsWith(page) || value.startsWith('data:') || value.startsWith('blob:')));
});
