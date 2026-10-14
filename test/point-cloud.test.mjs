import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readPointCloud as readSelectedPointCloud } from '../src/point-cloud.js';
import { fixtureSource } from './fixture-source.mjs';
import { decodeLazRecords } from '../src/point-cloud-decode.js';
import { coordinateReference } from '../src/coordinates.js';

const lengths = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
const wkt = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]\0';
const expected = [135, 35, -4, 135.0001, 35.0002, 13, 135.00025, 35.0004, 28];
const source = fixtureSource('http://localhost:8080/samples/point-cloud/');
const readPointCloud = (url, options = {}) => readSelectedPointCloud(url, { source, ...options });
function close(actual, wanted) {
  assert.equal(actual.length, wanted.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - wanted[i]) < 1e-9, `${i}: ${value} != ${wanted[i]}`));
}

function las({ format = 0, minor = 2, metadata = 'none', metadataText = wkt, count = 1, xy = [100, 200] } = {}) {
  const headerLength = minor === 4 ? 375 : minor === 3 ? 235 : 227;
  const wktBytes = metadata === 'none' ? new Uint8Array() : new TextEncoder().encode(metadataText);
  const extended = metadata === 'evlr';
  const pointOffset = headerLength + (extended || !wktBytes.length ? 0 : 54 + wktBytes.length);
  const pointEnd = pointOffset + lengths[format] * count;
  const file = new Uint8Array(pointEnd + (extended ? 60 + wktBytes.length : 0));
  const dv = new DataView(file.buffer);
  file.set(new TextEncoder().encode('LASF'));
  dv.setUint8(24, 1); dv.setUint8(25, minor);
  dv.setUint16(6, minor === 4 && metadata !== 'none' ? 16 : 0, true);
  dv.setUint16(94, headerLength, true); dv.setUint32(96, pointOffset, true);
  dv.setUint32(100, wktBytes.length && !extended ? 1 : 0, true);
  dv.setUint8(104, format); dv.setUint16(105, lengths[format], true);
  dv.setUint32(107, minor === 4 && format >= 6 ? 0 : count, true);
  if (minor === 4) {
    dv.setBigUint64(247, BigInt(count), true);
    dv.setBigUint64(235, extended ? BigInt(pointEnd) : 0n, true);
    dv.setUint32(243, extended ? 1 : 0, true);
  }
  [0.000001, 0.000001, 0.01].forEach((value, i) => dv.setFloat64(131 + i * 8, value, true));
  [135, 35, 10].forEach((value, i) => dv.setFloat64(155 + i * 8, value, true));
  [xy[0], xy[1], -1400].forEach((value, axis) => {
    const scaled = value * [0.000001, 0.000001, 0.01][axis] + [135, 35, 10][axis];
    dv.setFloat64(179 + axis * 16, scaled, true); dv.setFloat64(187 + axis * 16, scaled, true);
    for (let i = 0; i < count; i++) dv.setInt32(pointOffset + i * lengths[format] + axis * 4, value, true);
  });
  if (wktBytes.length) {
    const start = extended ? pointEnd : headerLength;
    file.set(new TextEncoder().encode('LASF_Projection'), start + 2);
    dv.setUint16(start + 18, 2112, true);
    if (extended) dv.setBigUint64(start + 20, BigInt(wktBytes.length), true);
    else dv.setUint16(start + 20, wktBytes.length, true);
    file.set(wktBytes, start + (extended ? 60 : 54));
  }
  return file;
}

test('CityGML LAS/LAZ references: decoding, LAS formats, CRS/axes/heights, cancellation, and local scope', async () => {
  const oldFetch = globalThis.fetch, oldLocation = globalThis.location;
  globalThis.location = { href: 'http://localhost:8080/' };
  let bytes = las(), calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(new URL(url).origin, 'http://localhost:8080');
    assert.equal(options.redirect, 'error');
    options.signal?.throwIfAborted();
    return new Response(bytes);
  };
  const load = options => readPointCloud('/samples/point-cloud/check.las', options);
  try {
    const wasm = await readFile(new URL('../node_modules/@voxelkloud/wasm-codecs/dist/voxelkloud_wasm_codecs_bg.wasm', import.meta.url));
    const decodeLaz = file => decodeLazRecords(file, wasm);
    for (let format = 0; format <= 10; format++) {
      let raw;
      for (const extension of ['las', 'laz']) {
        bytes = await readFile(new URL(`./fixtures/point-cloud/cloud${format}.${extension}`, import.meta.url));
        assert.equal(Boolean(bytes[104] & 128), extension === 'laz');
        const cloud = await load({ decodeLaz });
        assert.ok(cloud.positions instanceof Float64Array);
        assert.equal(cloud.count, 3);
        close(cloud.positions, expected);
        if ([2, 3, 5, 7, 8, 10].includes(format)) assert.deepEqual([...cloud.colors], [255, 0, 0, 0, 255, 0, 128, 128, 255]);
        else assert.equal(cloud.colors, undefined);
        if (extension === 'las') raw = new Uint8Array(bytes);
        else {
          const header = new DataView(raw.buffer);
          const start = header.getUint32(96, true), length = header.getUint16(105, true);
          assert.deepEqual((await decodeLaz(bytes)).points, raw.subarray(start, start + 3 * length));
        }
      }
    }
    for (const name of ['cloud0-pointwise.laz', 'cloud0-tail-table.laz', 'cloud0-item-v1.laz']) {
      bytes = await readFile(new URL(`./fixtures/point-cloud/${name}`, import.meta.url));
      close((await load({ decodeLaz })).positions, expected);
    }
    for (const minor of [0, 1, 2, 3, 4]) {
      const max = [1, 1, 3, 5, 10][minor];
      for (let format = 0; format <= max; format++) {
        bytes = las({ minor, format, metadata: minor === 4 ? 'wkt' : 'none' });
        const cloud = await load({ srsName: 'EPSG:4326' });
        close(cloud.positions, [135.0001, 35.0002, -4]);
      }
    }
    bytes = las({ minor: 4, format: 8, metadata: 'evlr' });
    close((await load()).positions, [135.0001, 35.0002, -4]);
    const compound = `COMPD_CS["Synthetic [name] with ""quote""",${wkt.slice(0, -1)},VERT_CS["Original height",VERT_DATUM["Synthetic",2005],UNIT["metre",1],AXIS["Height",UP]]]\0`;
    bytes = las({ minor: 4, format: 6, metadata: 'wkt', metadataText: compound });
    close((await load()).positions, [135.0001, 35.0002, -4]);
    bytes = las({ minor: 4, format: 6, metadata: 'wkt', metadataText: compound.slice(0, -2) + '\0' });
    await assert.rejects(load(), /compound LAS WKT/);
    bytes = las({ minor: 4, format: 6, metadata: 'wkt', metadataText: 'PROJCS["Missing datum",PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",36],PARAMETER["central_meridian",139.83333333333333],PARAMETER["scale_factor",0.9999],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]\0' });
    await assert.rejects(load(), /ellipsoid/);
    const radians = wkt.replace('UNIT["degree",0.0174532925199433]', 'UNIT["radian",1]');
    const projectedRadians = `PROJCS["Non-degree base",${radians.slice(0, -1)},PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]\0`;
    bytes = las({ minor: 4, format: 6, metadata: 'wkt', metadataText: projectedRadians });
    await assert.rejects(load(), /non-degree/);
    bytes = las({ minor: 4, format: 6, metadata: 'wkt', metadataText: radians, xy: [0, 0] });
    new DataView(bytes.buffer).setFloat64(155, Math.PI * 0.75, true);
    new DataView(bytes.buffer).setFloat64(163, Math.PI * 35 / 180, true);
    close((await load()).positions, [135, 35, -4]);
    // Explicit declaration wins over file metadata, LAS easting/northing matches GML north/east.
    bytes = las({ minor: 4, metadata: 'wkt' });
    const dv = new DataView(bytes.buffer);
    dv.setFloat64(131, 1, true); dv.setFloat64(139, 1, true);
    dv.setFloat64(155, 0, true); dv.setFloat64(163, 0, true);
    const reference = coordinateReference({ srsName: 'EPSG:6677', dimension: 3 });
    close((await load({ srsName: 'EPSG:6677' })).positions, reference.toGeographic([200, 100, -4]));
    bytes = las();
    await assert.rejects(load(), /CRS/);
    await assert.rejects(load({ srsName: '' }), /srsName/);
    await assert.rejects(load({ srsName: 'EPSG:999999' }), /Unsupported/);
    const before = calls;
    for (const url of ['https://outside.invalid/data/a.las', '/outside.las', '/data/%2e%2e/outside.las', 'file:///data/a.las']) {
      await assert.rejects(readPointCloud(url, { srsName: 'EPSG:4326' }));
    }
    assert.equal(calls, before);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(load({ signal: aborted.signal, srsName: 'EPSG:4326' }), { name: 'AbortError' });
    assert.equal(calls, before);
    bytes = las({ count: 20000 });
    const active = new AbortController();
    setTimeout(() => active.abort(), 1);
    await assert.rejects(load({ signal: active.signal, srsName: 'EPSG:4326' }), { name: 'AbortError' });
    // Abort while a Worker is pending must terminate it, not merely ignore a late result.
    const oldWorker = globalThis.Worker;
    let created = 0, terminated = 0;
    globalThis.Worker = class {
      constructor(url, options) { assert.match(url.href, /point-cloud-worker\.js$/); assert.equal(options.type, 'module'); created++; }
      postMessage(buffer, transfers) { assert.ok(buffer instanceof ArrayBuffer); assert.deepEqual(transfers, [buffer]); }
      terminate() { terminated++; }
    };
    try {
      bytes = await readFile(new URL('./fixtures/point-cloud/cloud0.laz', import.meta.url));
      const pending = new AbortController();
      setTimeout(() => pending.abort(), 10);
      await assert.rejects(load({ signal: pending.signal }), { name: 'AbortError' });
      assert.equal(created, 1); assert.equal(terminated, 1);
    } finally {
      if (oldWorker === undefined) delete globalThis.Worker;
      else globalThis.Worker = oldWorker;
    }
    for (const mutate of [
      dv => dv.setFloat64(131, NaN, true), dv => dv.setFloat64(155, Infinity, true),
      dv => dv.setUint32(107, 500, true), dv => dv.setUint8(104, 64),
      dv => dv.setUint8(104, 6), dv => dv.setUint16(105, 2, true),
      dv => dv.setFloat64(139, Number.MAX_VALUE, true),
    ]) {
      bytes = las(); mutate(new DataView(bytes.buffer));
      await assert.rejects(load({ srsName: 'EPSG:4326' }));
    }
    bytes = las({ count: 0 });
    await assert.rejects(load({ srsName: 'EPSG:4326' }), /pointCount/);
    // Codec disagreement and malformed data are errors, not raw bytes or an empty success.
    bytes = new Uint8Array(await readFile(new URL('./fixtures/point-cloud/cloud6.laz', import.meta.url)));
    bytes[104] = 128 | 4;
    new DataView(bytes.buffer).setUint8(25, 3);
    new DataView(bytes.buffer).setUint16(105, 57, true);
    new DataView(bytes.buffer).setUint32(107, 3, true);
    await assert.rejects(load({ srsName: 'EPSG:4326', decodeLaz }), /compressor|item structure/);
    bytes = new Uint8Array(await readFile(new URL('./fixtures/point-cloud/cloud6.laz', import.meta.url)));
    await assert.rejects(load({ decodeLaz: () => ({ count: 0 }) }), /conflicts/);
    new DataView(bytes.buffer).setBigUint64(247, BigInt(Math.floor(2 ** 30 / 30) + 1), true);
    await assert.rejects(load({ decodeLaz }), /1 GiB/);
    bytes = new Uint8Array(await readFile(new URL('./fixtures/point-cloud/cloud0.laz', import.meta.url)));
    bytes = bytes.subarray(0, 30);
    await assert.rejects(load({ decodeLaz }), /header/);
    bytes = las();
    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(load({ srsName: 'EPSG:4326' }), /HTTP 404/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldLocation === undefined) delete globalThis.location;
    else globalThis.location = oldLocation;
  }
});
