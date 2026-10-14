// Synthetic fixtures only. Run: node test/fixtures/tiles/generate.mjs
import { writeFile } from 'node:fs/promises';
import { Matrix4 } from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer/three';

const directory = new URL('./', import.meta.url);
const positions = new Float32Array([
  -5, 0, -4, 5, 0, -4, 5, 12, -4, -5, 12, -4,
  -5, 0, 4, 5, 0, 4, 5, 12, 4, -5, 12, 4,
]);
const indices = new Uint16Array([
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2,
  0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
]);
const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
const gltf = {
  asset: { version: '2.0', generator: 'Synthetic wireframe box; no real PLATEAU data' },
  scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.3, 0.6, 1] } }],
  buffers: [{ byteLength: binary.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
    { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-5, 0, -4], max: [5, 12, 4] },
    { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
  ],
};
const json = Buffer.from(JSON.stringify(gltf));
const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const header = Buffer.alloc(20), binHeader = Buffer.alloc(8);
header.write('glTF');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(28 + paddedJson.length + binary.length, 8);
header.writeUInt32LE(paddedJson.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
binHeader.writeUInt32LE(binary.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
const glb = Buffer.concat([header, paddedJson, binHeader, binary]);
const featureJson = Buffer.from('{"BATCH_LENGTH":0}');
const features = Buffer.concat([featureJson, Buffer.alloc((8 - (28 + featureJson.length) % 8) % 8, 0x20)]);
const b3dmBody = Buffer.concat([glb, Buffer.alloc((8 - glb.length % 8) % 8)]);
const b3dmHeader = Buffer.alloc(28);
b3dmHeader.write('b3dm');
b3dmHeader.writeUInt32LE(1, 4);
b3dmHeader.writeUInt32LE(28 + features.length + b3dmBody.length, 8);
b3dmHeader.writeUInt32LE(features.length, 12);

const frame = new Matrix4();
WGS84_ELLIPSOID.getEastNorthUpFrame(35 * Math.PI / 180, 139 * Math.PI / 180, 0, frame);
const box = { box: [0, 0, 6, 5, 0, 0, 0, 4, 0, 0, 0, 6] };
const tileset = {
  asset: { version: '1.0', gltfUpAxis: 'Y' }, geometricError: 64,
  root: {
    transform: frame.toArray(), boundingVolume: { box: [0, 0, 6, 21, 0, 0, 0, 4, 0, 0, 0, 6] },
    geometricError: 64, refine: 'ADD',
    children: ['building.gltf', 'building.b3dm'].map((uri, index) => ({
      transform: new Matrix4().makeTranslation(index ? 16 : -16, 0, 0).toArray(),
      boundingVolume: box, geometricError: 0, content: { uri },
    })),
  },
};
gltf.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
await Promise.all([
  writeFile(new URL('tileset.json', directory), JSON.stringify(tileset, null, 2) + '\n'),
  writeFile(new URL('building.gltf', directory), JSON.stringify(gltf, null, 2) + '\n'),
  writeFile(new URL('building.glb', directory), glb),
  writeFile(new URL('building.b3dm', directory), Buffer.concat([b3dmHeader, features, b3dmBody])),
]);
