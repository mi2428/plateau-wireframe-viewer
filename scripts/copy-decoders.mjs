import { cp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
for (const [source, target] of [
  ['three/examples/jsm/libs/draco', 'draco'],
  ['three/examples/jsm/libs/basis', 'basis'],
]) {
  const output = new URL(`public/decoders/${target}/`, root);
  await mkdir(output, { recursive: true });
  // The glTF-only decoder cannot decode Draco point clouds in pnts.
  await cp(fileURLToPath(new URL(`node_modules/${source}/`, root)), fileURLToPath(output), {
    recursive: true, filter: path => !path.endsWith('/gltf'),
  });
  // Both Three.js codecs use Apache-2.0; keep the complete license available offline.
  await cp(new URL('node_modules/3d-tiles-renderer/LICENSE', root), new URL('LICENSE', output));
}

const laz = new URL('public/decoders/laz/', root);
// This directory is generated: remove the obsolete laz-perf backend and every stale file.
await rm(laz, { recursive: true, force: true });
await mkdir(laz, { recursive: true });
for (const [source, target] of [
  ['dist/voxelkloud_wasm_codecs_bg.wasm', 'voxelkloud_wasm_codecs_bg.wasm'],
  ['LICENSE', 'LICENSE'],
  ['THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-NOTICES.md'],
]) {
  await cp(new URL(`node_modules/@voxelkloud/wasm-codecs/${source}`, root), new URL(target, laz));
}
// The MIT wrapper statically links laz-rs (Apache-2.0); include that license as well.
await cp(new URL('node_modules/3d-tiles-renderer/LICENSE', root), new URL('LICENSE-APACHE-2.0', laz));
