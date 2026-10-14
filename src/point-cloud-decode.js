import { initLazCodec, decodeLazFile } from '@voxelkloud/wasm-codecs';

// Used inside a fresh browser Worker; Node checks explicitly supply local WASM bytes.
export async function decodeLazRecords(file, wasm) {
  await initLazCodec(wasm);
  const decoded = decodeLazFile(file);
  let header;
  try {
    header = decoded.header;
    return { points: decoded.points, count: decoded.pointCount, length: decoded.pointSize, format: header.pointFormat };
  } finally {
    header?.free();
    decoded.free();
  }
}
