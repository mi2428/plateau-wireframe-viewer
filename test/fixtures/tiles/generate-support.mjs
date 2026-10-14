// All geometry is synthetic. Run: node test/fixtures/tiles/generate-support.mjs
import { readFile, writeFile } from 'node:fs/promises';
import draco3d from 'draco3d';
import { MeshoptEncoder } from 'meshoptimizer';
import { Matrix4 } from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer/three';

const directory = new URL('./', import.meta.url);
const save = (name, bytes) => writeFile(new URL(name, directory), bytes);
const json = value => Buffer.from(JSON.stringify(value));
const pad = (bytes, alignment, offset = 0, fill = 0) => Buffer.concat([bytes, Buffer.alloc((alignment - (bytes.length + offset) % alignment) % alignment, fill)]);

function glb(gltf, binary) {
  const text = pad(json(gltf), 4, 0, 0x20), body = pad(binary, 4);
  const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
  header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + text.length + body.length, 8);
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  binHeader.writeUInt32LE(body.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, text, binHeader, body]);
}

function tile(magic, features, binary, body = Buffer.alloc(0), format = 1) {
  const size = magic === 'i3dm' ? 32 : 28;
  const text = pad(json(features), 8, size, 0x20), bin = pad(binary, 8);
  const payload = pad(body, 8, 0, magic === 'i3dm' && format === 0 ? 0x20 : 0), header = Buffer.alloc(size);
  header.write(magic); header.writeUInt32LE(1, 4);
  header.writeUInt32LE(size + text.length + bin.length + payload.length, 8);
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(bin.length, 16);
  if (magic === 'i3dm') header.writeUInt32LE(format, 28);
  return Buffer.concat([header, text, bin, payload]);
}

function composite(children) {
  const header = Buffer.alloc(16);
  header.write('cmpt'); header.writeUInt32LE(1, 4);
  header.writeUInt32LE(16 + children.reduce((sum, child) => sum + child.length, 0), 8);
  header.writeUInt32LE(children.length, 12);
  return Buffer.concat([header, ...children]);
}

function subtree(value, binary = Buffer.alloc(0)) {
  const text = pad(json(value), 8, 0, 0x20), body = pad(binary, 8), header = Buffer.alloc(24);
  header.write('subt'); header.writeUInt32LE(1, 4);
  header.writeBigUInt64LE(BigInt(text.length), 8); header.writeBigUInt64LE(BigInt(body.length), 16);
  return Buffer.concat([header, text, body]);
}

const position = new Float32Array([-2, 0, 0, 0, 1, 0, 2, 2, 0]);
const points = tile('pnts', { POINTS_LENGTH: 3, POSITION: { byteOffset: 0 }, RTC_CENTER: [0, 0, 3] }, Buffer.from(position.buffer));
const building = await readFile(new URL('building.glb', directory));
const b3dm = await readFile(new URL('building.b3dm', directory));
const instances = tile('i3dm', { INSTANCES_LENGTH: 2, POSITION: { byteOffset: 0 } },
  Buffer.from(new Float32Array([-10, 0, 3, 10, 0, 3]).buffer), building);
const externalInstance = tile('i3dm', { INSTANCES_LENGTH: 2, POSITION: { byteOffset: 0 } },
  Buffer.from(new Float32Array([-10, 0, 3, 10, 0, 3]).buffer), Buffer.from('building.glb'), 0);
// External i3dm URI padding is spaces; binary glTF padding is zero bytes.
const mixed = composite([b3dm, instances, points]);
await Promise.all([
  save('points.pnts', points), save('instances.i3dm', instances), save('external-instances.i3dm', externalInstance),
  save('mixed.cmpt', mixed), save('nested.cmpt', composite([mixed, points])),
]);

const volume = { box: [0, 0, 6, 30, 0, 0, 0, 30, 0, 0, 0, 20] };
const tileset = (uri, version = '1.0') => ({ asset: { version }, geometricError: 64,
  root: { boundingVolume: volume, geometricError: 0, refine: 'ADD', content: { uri } } });
for (const [name, uri] of [['pnts', 'points.pnts'], ['i3dm', 'instances.i3dm'], ['external-i3dm', 'external-instances.i3dm'], ['cmpt', 'mixed.cmpt'], ['nested-cmpt', 'nested.cmpt']]) {
  await save(`${name}-tileset.json`, json(tileset(uri)));
}

const multiple = tileset('unused', '1.1');
delete multiple.root.content;
multiple.root.contents = [{ uri: 'points.pnts' }, { uri: 'building.glb' }, { uri: 'instances.i3dm' }];
await save('multiple-tileset.json', json(multiple));
const nested = tileset('multiple-tileset.json', '1.1');
await save('nested-tileset.json', json(nested));

// Two content availability streams: all five point tiles, and three model tiles.
const implicit = tileset('unused', '1.1');
delete implicit.root.content;
implicit.root.geometricError = 64;
implicit.root.contents = [{ uri: 'implicit-{level}-{x}-{y}.pnts' }, { uri: 'implicit-model-{level}-{x}-{y}.glb' }];
implicit.root.implicitTiling = { subdivisionScheme: 'QUADTREE', subtreeLevels: 2, availableLevels: 2,
  subtrees: { uri: 'implicit-{level}-{x}-{y}.subtree' } };
await save('implicit-tileset.json', json(implicit));
await save('implicit-0-0-0.subtree', subtree({
  buffers: [{ byteLength: 4, uri: 'implicit-availability.bin' }],
  bufferViews: [0, 1, 2].map(byteOffset => ({ buffer: 0, byteOffset, byteLength: byteOffset === 2 ? 2 : 1 })),
  tileAvailability: { bitstream: 0 }, contentAvailability: [{ bitstream: 0 }, { bitstream: 1 }], childSubtreeAvailability: { bitstream: 2 },
}));
await save('implicit-availability.bin', Buffer.from([0b11111, 0b10101, 0, 0]));

const triangle = new Float32Array([-.5, 0, -.5, .5, 0, -.5, 0, 1, .5]);
function triangleGltf(binary) {
  return { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: triangle.byteLength }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-.5, 0, -.5], max: [.5, 1, .5] }] };
}
for (const [level, x, y] of [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1]]) {
  const center = [level ? (x ? 15 : -15) : 0, level ? (y ? 15 : -15) : 0, 3];
  await save(`implicit-${level}-${x}-${y}.pnts`, tile('pnts', { POINTS_LENGTH: 3, POSITION: { byteOffset: 0 }, RTC_CENTER: center }, Buffer.from(position.buffer)));
  const data = Buffer.from(triangle.buffer), gltf = triangleGltf(data);
  // glTF is Y-up, content coordinates are z-up after the tiles loader's adjustment.
  gltf.nodes[0].translation = [center[0], center[2], -center[1]];
  await save(`implicit-model-${level}-${x}-${y}.glb`, glb(gltf, data));
}

const topologyPosition = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0, 3, 0, 0, 3, 2, 0]);
const topologyData = Buffer.from(topologyPosition.buffer), topology = triangleGltf(topologyData);
topology.bufferViews[0].byteLength = topologyData.length;
Object.assign(topology.accessors[0], { count: 6, min: [0, 0, 0], max: [3, 2, 0] });
topology.meshes[0].primitives = Array.from({ length: 7 }, (_, mode) => ({ attributes: { POSITION: 0 }, mode }));
await save('topology.glb', glb(topology, topologyData));
await save('topology-tileset.json', json(tileset('topology.glb', '1.1')));

const skinBytes = [Buffer.from(triangle.buffer), Buffer.from(new Uint16Array(12).buffer),
  Buffer.from(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]).buffer),
  Buffer.from(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).buffer),
  Buffer.from(new Float32Array([-3, 0, 0, 3, 0, 0]).buffer)];
const skinData = Buffer.concat(skinBytes), skin = triangleGltf(skinData);
let offset = 0;
skin.bufferViews = skinBytes.map(bytes => { const view = { buffer: 0, byteOffset: offset, byteLength: bytes.length }; offset += bytes.length; return view; });
skin.accessors.push(
  { bufferView: 1, componentType: 5123, count: 3, type: 'VEC4' },
  { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
  { bufferView: 3, componentType: 5126, count: 1, type: 'MAT4' },
  { bufferView: 4, componentType: 5126, count: 2, type: 'VEC3' });
skin.meshes[0].primitives[0].attributes = { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 };
skin.nodes = [{ mesh: 0, skin: 0 }, {}, { mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 4 } } } }];
skin.scenes[0].nodes = [0, 1, 2];
skin.skins = [{ joints: [1], inverseBindMatrices: 3 }];
skin.extensionsUsed = skin.extensionsRequired = ['EXT_mesh_gpu_instancing'];
await save('skin-instances.glb', glb(skin, skinData));
await save('skin-instances-tileset.json', json(tileset('skin-instances.glb', '1.1')));

const encoder = await draco3d.createEncoderModule({});
function dracoEncode(positions, mesh) {
  const builder = mesh ? new encoder.MeshBuilder() : new encoder.PointCloudBuilder();
  const geometry = mesh ? new encoder.Mesh() : new encoder.PointCloud();
  const id = mesh ? builder.AddFloatAttributeToMesh(geometry, encoder.POSITION, positions.length / 3, 3, positions)
    : builder.AddFloatAttribute(geometry, encoder.POSITION, positions.length / 3, 3, positions);
  if (mesh) builder.AddFacesToMesh(geometry, 1, new Uint32Array([0, 1, 2]));
  const codec = new encoder.Encoder(), encoded = new encoder.DracoInt8Array();
  codec.SetSpeedOptions(5, 5); codec.SetAttributeQuantization(encoder.POSITION, 14);
  const length = mesh ? codec.EncodeMeshToDracoBuffer(geometry, encoded) : codec.EncodePointCloudToDracoBuffer(geometry, false, encoded);
  if (length <= 0) throw new Error('Synthetic Draco encoding failed');
  const bytes = Buffer.from(Array.from({ length }, (_, i) => encoded.GetValue(i)));
  for (const object of [builder, geometry, codec, encoded]) encoder.destroy(object);
  return { id, bytes };
}
const compressed = dracoEncode(triangle, true), draco = triangleGltf(compressed.bytes);
draco.bufferViews[0].byteLength = compressed.bytes.length;
delete draco.accessors[0].bufferView;
draco.accessors.push({ componentType: 5123, count: 3, type: 'SCALAR' });
draco.meshes[0].primitives[0].indices = 1;
draco.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: compressed.id } } };
draco.extensionsUsed = draco.extensionsRequired = ['KHR_draco_mesh_compression'];
await save('draco.glb', glb(draco, compressed.bytes));
await save('draco-tileset.json', json(tileset('draco.glb', '1.1')));
const dracoPoints = dracoEncode(position, false);
await save('draco-points.pnts', tile('pnts', { POINTS_LENGTH: 3, RTC_CENTER: [0, 0, 3],
  extensions: { '3DTILES_draco_point_compression': { byteOffset: 0, byteLength: dracoPoints.bytes.length, properties: { POSITION: dracoPoints.id } } } }, dracoPoints.bytes));
await save('draco-pnts-tileset.json', json(tileset('draco-points.pnts')));

await MeshoptEncoder.ready;
const meshoptBytes = Buffer.from(MeshoptEncoder.encodeGltfBuffer(new Uint8Array(triangle.buffer), 3, 12, 'ATTRIBUTES'));
const meshopt = triangleGltf(meshoptBytes);
meshopt.buffers.push({ byteLength: triangle.byteLength });
meshopt.bufferViews[0] = { buffer: 1, byteOffset: 0, byteLength: triangle.byteLength, byteStride: 12,
  extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 0, byteLength: meshoptBytes.length, byteStride: 12, count: 3, mode: 'ATTRIBUTES', filter: 'NONE' } } };
meshopt.extensionsUsed = meshopt.extensionsRequired = ['EXT_meshopt_compression'];
await save('meshopt.glb', glb(meshopt, meshoptBytes));
await save('meshopt-tileset.json', json(tileset('meshopt.glb', '1.1')));

const instanceFeatures = { INSTANCES_LENGTH: 2, POSITION: { byteOffset: 0 } };
await save('i3dm-empty.i3dm', tile('i3dm', { INSTANCES_LENGTH: 0 }, Buffer.alloc(0), building));
await save('i3dm-empty-tileset.json', json(tileset('i3dm-empty.i3dm')));
const instanceBytes = Buffer.from(new Float32Array([-10, 0, 3, 10, 0, 3]).buffer);
const morph = triangleGltf(Buffer.from(triangle.buffer));
morph.meshes[0].weights = [1]; morph.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
for (const [name, model] of [
  ['i3dm-topology', glb(topology, topologyData)], ['i3dm-deformed', glb(skin, skinData)],
  ['i3dm-morph', glb(morph, Buffer.from(triangle.buffer))],
]) {
  await save(`${name}.i3dm`, tile('i3dm', instanceFeatures, instanceBytes, model));
  await save(`${name}-tileset.json`, json(tileset(`${name}.i3dm`)));
}
const quantizedBytes = Buffer.concat([
  Buffer.from(new Uint16Array([0, 0, 0, 65535, 0, 0]).buffer),
  Buffer.from(new Uint16Array([32768, 32768, 32768, 32768]).buffer),
  Buffer.from(new Uint16Array([65535, 32768, 65535, 32768]).buffer),
  Buffer.from(new Float32Array([1, 2]).buffer), Buffer.from(new Float32Array([1, 2, 3, 1, 1, 1]).buffer),
]);
await save('i3dm-table.i3dm', tile('i3dm', { INSTANCES_LENGTH: 2,
  POSITION_QUANTIZED: { byteOffset: 0 }, QUANTIZED_VOLUME_OFFSET: [-10, 0, 0], QUANTIZED_VOLUME_SCALE: [20, 0, 0],
  NORMAL_UP_OCT32P: { byteOffset: 12 }, NORMAL_RIGHT_OCT32P: { byteOffset: 20 },
  SCALE: { byteOffset: 28 }, SCALE_NON_UNIFORM: { byteOffset: 36 }, RTC_CENTER: [2, 0, 3],
}, quantizedBytes, glb(triangleGltf(Buffer.from(triangle.buffer)), Buffer.from(triangle.buffer))));
await save('i3dm-table-tileset.json', json(tileset('i3dm-table.i3dm')));
const enuFeatures = { INSTANCES_LENGTH: 1, POSITION: { byteOffset: 0 }, RTC_CENTER: [7, 11, 13], EAST_NORTH_UP: true };
const enuPosition = Buffer.from(new Float32Array([10, 5, 3]).buffer), plainTriangle = glb(triangleGltf(Buffer.from(triangle.buffer)), Buffer.from(triangle.buffer));
await save('i3dm-enu.i3dm', tile('i3dm', enuFeatures, enuPosition, plainTriangle));
await save('i3dm-enu-normals.i3dm', tile('i3dm', { ...enuFeatures, NORMAL_UP: { byteOffset: 12 }, NORMAL_RIGHT: { byteOffset: 24 } },
  Buffer.concat([enuPosition, Buffer.from(new Float32Array([0, 1, 0, 1, 0, 0]).buffer)]), plainTriangle));
const ecefFrame = new Matrix4();
WGS84_ELLIPSOID.getEastNorthUpFrame(35 * Math.PI / 180, 139 * Math.PI / 180, 120, ecefFrame);
const parentFrame = ecefFrame.multiply(new Matrix4().makeRotationZ(.4)).multiply(new Matrix4().makeScale(2, 3, 4));
const childFrame = new Matrix4().makeTranslation(5, -4, 2).multiply(new Matrix4().makeRotationY(.3));
for (const name of ['i3dm-enu', 'i3dm-enu-normals']) {
  const root = tileset('unused', '1.1'); delete root.root.content;
  root.root.transform = parentFrame.toArray(); root.root.geometricError = 64;
  root.root.children = [{ boundingVolume: volume, geometricError: 0, transform: childFrame.toArray(),
    contents: [{ uri: `${name}.i3dm` }, { uri: 'points.pnts' }] }];
  await save(`${name}-tileset.json`, json(root));
}

const embedded = (type, bytes) => `data:${type};base64,${bytes.toString('base64')}`;
const pointUri = embedded('application/octet-stream', points);
const left = tileset('building.glb', '1.1'), right = tileset(pointUri, '1.1');
for (const [root, x] of [[left.root, -12], [right.root, 12]]) {
  root.transform = new Matrix4().makeTranslation(x, 0, 0).toArray();
  root.refine = 'REPLACE'; root.geometricError = 8;
}
left.root.children = [{ boundingVolume: volume, geometricError: 0, content: { uri: 'topology.glb' }, transform: new Matrix4().makeTranslation(0, 0, 4).toArray() }];
right.root.children = [{ boundingVolume: volume, geometricError: 0, content: { uri: pointUri }, transform: new Matrix4().makeTranslation(0, 0, 4).toArray() }];
await save('external-left.json', json(left));
await save('external-right', json(right)); // JSON content does not require a suffix.
const external = tileset('unused', '1.1'); delete external.root.content;
external.root.refine = 'REPLACE';
external.root.transform = new Matrix4().makeTranslation(100, 200, 300).multiply(new Matrix4().makeRotationZ(Math.PI / 2)).toArray();
external.root.contents = [{ uri: 'external-left.json' }, { uri: 'external-right' }, { uri: 'draco.glb' }];
await save('external-multiple-tileset.json', json(external));
const joint = tileset('building.glb', '1.1');
joint.root.refine = 'REPLACE'; joint.root.geometricError = 8;
joint.root.transform = external.root.transform;
joint.root.children = [{ boundingVolume: volume, geometricError: 0, contents: external.root.contents }];
await save('external-joint-tileset.json', json(joint));

const embeddedSet = tileset('unused', '1.1'); delete embeddedSet.root.content;
embeddedSet.root.contents = [{ uri: embedded('model/gltf-binary', building) }, { uri: pointUri },
  { uri: embedded('application/json', json(tileset('building.glb', '1.1'))) }];
await save('embedded-tileset.json', json(embeddedSet));
await save('extensionless-glb', building);
await save('extensionless-gltf', Buffer.from('\n ' + await readFile(new URL('building.gltf', directory), 'utf8')));
await save('extensionless-tileset', json(tileset('extensionless-glb', '1.1')));
for (const [name, uri] of [['extensionless-glb', 'extensionless-glb'], ['extensionless-gltf', 'extensionless-gltf'], ['extensionless-nested', 'extensionless-tileset']]) {
  await save(`${name}-tileset.json`, json(tileset(uri, '1.1')));
}
