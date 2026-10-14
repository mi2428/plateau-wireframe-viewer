import { decodeLazRecords } from './point-cloud-decode.js';

self.onmessage = async ({ data }) => {
  try {
    // Bytes are passed explicitly: the codec's default URL / file loader is never used.
    const response = await fetch(new URL('../decoders/laz/voxelkloud_wasm_codecs_bg.wasm', self.location.href), { redirect: 'error' });
    if (!response.ok) throw new Error(`LAZ WASM load failed: HTTP ${response.status}`);
    const result = await decodeLazRecords(new Uint8Array(data), new Uint8Array(await response.arrayBuffer()));
    self.postMessage(result, [result.points.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message ?? String(error) });
  }
};
