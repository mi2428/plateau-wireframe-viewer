import { Vlr } from 'copc/lib/las/vlr.js';
import { View } from 'copc/lib/las/view.js';
import proj4 from 'proj4';
import { coordinateReference } from './coordinates.js';

const lengths = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
const viewFormats = new Set([0, 1, 2, 3, 6, 7, 8]);
const geographic = '+proj=longlat +ellps=GRS80 +no_defs';
const text = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\0.*$/s, '');

function safeUint64(dv, offset) {
  const value = Number(dv.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) throw new Error('LAS 64-bit value exceeds browser integer precision.');
  return value;
}

function headerOf(file) {
  if (file.length < 227 || text(file.subarray(0, 4)) !== 'LASF') throw new Error('LAS header is too short or missing the LASF signature.');
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const major = dv.getUint8(24), minor = dv.getUint8(25);
  if (major !== 1 || minor > 4) throw new Error(`Unsupported LAS version: ${major}.${minor}`);
  const minimum = minor === 4 ? 375 : minor === 3 ? 235 : 227;
  const headerLength = dv.getUint16(94, true), pointDataOffset = dv.getUint32(96, true);
  if (file.length < minimum || headerLength < minimum || pointDataOffset < headerLength || pointDataOffset > file.length) {
    throw new Error('Inconsistent LAS headerLength / pointDataOffset.');
  }
  const flags = dv.getUint8(104), pointDataRecordFormat = flags & 63;
  if (flags & 64 || pointDataRecordFormat > [1, 1, 3, 5, 10][minor]) throw new Error('Inconsistent LAS point format / version / compression flag.');
  const pointDataRecordLength = dv.getUint16(105, true);
  if (pointDataRecordLength < lengths[pointDataRecordFormat]) throw new Error('LAS point record length is too short.');
  const legacyCount = dv.getUint32(107, true);
  const pointCount = minor === 4 ? safeUint64(dv, 247) : legacyCount;
  if (!pointCount || minor === 4 && (pointDataRecordFormat >= 6 ? legacyCount !== 0 : legacyCount !== 0 && legacyCount !== pointCount)) {
    throw new Error('LAS pointCount is empty or inconsistent.');
  }
  const globalEncoding = minor >= 2 ? dv.getUint16(6, true) : 0;
  if (pointDataRecordFormat >= 6 && !(globalEncoding & 16)) throw new Error('LAS 1.4 format 6+ requires the WKT flag.');
  const scale = [0, 1, 2].map(axis => dv.getFloat64(131 + axis * 8, true));
  const offset = [0, 1, 2].map(axis => dv.getFloat64(155 + axis * 8, true));
  if (!scale.every(value => Number.isFinite(value) && value > 0) || !offset.every(Number.isFinite)) {
    throw new Error('Invalid or non-finite LAS scale / offset.');
  }
  for (let axis = 0; axis < 3; axis++) {
    const max = dv.getFloat64(179 + axis * 16, true), min = dv.getFloat64(187 + axis * 16, true);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error('LAS bounds are non-finite or inconsistent.');
  }
  const evlrOffset = minor === 4 ? safeUint64(dv, 235) : 0;
  const evlrCount = minor === 4 ? dv.getUint32(243, true) : 0;
  const vlrCount = dv.getUint32(100, true);
  if (vlrCount > (pointDataOffset - headerLength) / 54 ||
      evlrCount && (evlrOffset < pointDataOffset || evlrOffset > file.length || evlrCount > (file.length - evlrOffset) / 60)) {
    throw new Error('Inconsistent LAS VLR / EVLR range.');
  }
  const compressed = Boolean(flags & 128);
  const pointEnd = pointDataOffset + pointCount * pointDataRecordLength;
  if (!Number.isSafeInteger(pointEnd) || !compressed && (pointEnd > file.length || evlrCount && pointEnd > evlrOffset)) {
    throw new Error('Inconsistent LAS pointCount / point record range.');
  }
  // copc Header.parse accepts only 1.2/1.4 and requires 375 bytes even for short 1.2 files.
  // These common header fields also cover 1.0/1.1/1.3 without rewriting source bytes.
  return { majorVersion: major, minorVersion: minor, headerLength, pointDataOffset, vlrCount,
    pointDataRecordFormat, pointDataRecordLength, pointCount, scale, offset, evlrOffset, evlrCount, globalEncoding, compressed };
}

async function recordsOf(file, header) {
  const get = async (start, end) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.length) {
      throw new Error('LAS VLR / EVLR is outside the file.');
    }
    return file.subarray(start, end);
  };
  const records = await Vlr.walk(get, header);
  for (const record of records) {
    const end = record.contentOffset + record.contentLength;
    if (end > (record.isExtended ? file.length : header.pointDataOffset)) throw new Error('LAS VLR / EVLR content is outside its bounds.');
    record.bytes = await Vlr.fetch(get, record);
  }
  return records;
}

function epsgReference(srsName) {
  const reference = coordinateReference({ srsName, dimension: 3 });
  // LAS X/Y are easting/northing (or longitude/latitude), not EPSG/GML axis order.
  return coordinateReference({ srsName, dimension: 3,
    axisLabels: reference.code >= 6669 && reference.code <= 6687 ? 'easting northing height' : 'longitude latitude height' });
}

function horizontalWkt(source) {
  if (!/^(?:COMPD_CS|COMPOUNDCRS)\s*\[/i.test(source)) return source;
  // proj4 does not unwrap compound WKT; retain its horizontal component and original LAS Z.
  let depth = 0, quoted = false, start, horizontal;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (depth === 1 && start == null && /[PG]/i.test(char) && /^(?:PROJCS|GEOGCS|PROJCRS|GEOGCRS|GEODCRS)\s*\[/i.test(source.slice(i))) start = i;
      if (char === '[') depth++;
      if (char === ']') {
        depth--;
        if (start != null && depth === 1) {
          if (horizontal) throw new Error('Duplicate horizontal CRS in compound LAS WKT.');
          horizontal = source.slice(start, i + 1);
          start = undefined;
        }
        if (depth < 0 || depth === 0 && source.slice(i + 1).trim()) throw new Error('Unbalanced brackets in compound LAS WKT.');
      }
    }
  }
  if (quoted || depth !== 0 || !horizontal) throw new Error('Cannot resolve horizontal CRS in compound LAS WKT.');
  return horizontal;
}

function referenceOf(records, header, srsName) {
  if (srsName != null) return { ...epsgReference(srsName), description: srsName };
  const projection = records.filter(record => record.userId === 'LASF_Projection');
  const wkt = projection.filter(record => record.recordId === 2112);
  if (wkt.length > 1) throw new Error('Duplicate LAS CRS WKT.');
  if (wkt.length) {
    const source = text(wkt[0].bytes);
    if (!wkt[0].bytes.length || wkt[0].bytes.at(-1) !== 0 ||
        !/^(?:GEOGCS|PROJCS|COMPD_CS|GEODCRS|GEOGCRS|PROJCRS|COMPOUNDCRS)\s*\[/i.test(source)) {
      throw new Error('LAS CRS WKT is empty, invalid or unsupported.');
    }
    const horizontal = horizontalWkt(source);
    if (!/\b(?:SPHEROID|ELLIPSOID)\s*\[/i.test(horizontal.replace(/"(?:[^"]|"")*"/g, '""'))) {
      throw new Error('LAS WKT has no horizontal CRS ellipsoid definition; an unknown ellipsoid is not assumed.');
    }
    const sourceProjection = new proj4.Proj(horizontal);
    if (sourceProjection.projName === 'geocent') throw new Error('Geocentric XYZ LAS is inconsistent with elevation Z point clouds.');
    const angular = sourceProjection.projName === 'longlat';
    const baseAngleUnit = sourceProjection.GEOGCS?.UNIT?.convert;
    if (!angular && baseAngleUnit != null && (!Number.isFinite(baseAngleUnit) || Math.abs(baseAngleUnit - Math.PI / 180) > 1e-14)) {
      throw new Error('proj4 WKT1 projection parameters use degrees; a non-degree projected WKT cannot be safely converted.');
    }
    const degreesPerUnit = angular ? (sourceProjection.UNIT?.convert ?? sourceProjection.to_meter) * 180 / Math.PI : 1;
    if (!Number.isFinite(degreesPerUnit) || degreesPerUnit <= 0) throw new Error('Unknown or invalid LAS WKT angular unit.');
    if (angular && sourceProjection.from_greenwich) sourceProjection.from_greenwich *= degreesPerUnit;
    const converter = proj4(sourceProjection, geographic);
    return { description: 'LAS WKT', toGeographic([x, y, z]) {
      x *= degreesPerUnit; y *= degreesPerUnit;
      if (angular && (Math.abs(x) > 180 || Math.abs(y) > 90)) throw new Error('LAS longitude/latitude is out of bounds.');
      const [lon, lat] = converter.forward([x, y, z]); // LAS XY convention, regardless of WKT AXIS order.
      return [lon, lat, z]; // No vertical/geoid transform: retain source height.
    } };
  }
  if (header.globalEncoding & 16) throw new Error('LAS WKT flag has no corresponding CRS WKT.');
  const directories = projection.filter(record => record.recordId === 34735);
  if (directories.length !== 1) throw new Error('Unknown LAS CRS. Declare pointFileSrsName or provide WKT/GeoKeys.');
  const bytes = directories[0].bytes;
  if (bytes.length < 8 || bytes.length % 2) throw new Error('Invalid LAS GeoKeyDirectory.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint16(6, true);
  if (dv.getUint16(0, true) !== 1 || dv.getUint16(2, true) !== 1 || bytes.length < 8 + count * 8) {
    throw new Error('Invalid LAS GeoKeyDirectory version / length.');
  }
  const keys = new Map();
  for (let i = 0; i < count; i++) {
    const pos = 8 + i * 8, id = dv.getUint16(pos, true);
    if (keys.has(id)) throw new Error('Duplicate LAS GeoKey.');
    keys.set(id, [dv.getUint16(pos + 2, true), dv.getUint16(pos + 4, true), dv.getUint16(pos + 6, true)]);
  }
  function codeOf(id) {
    const entry = keys.get(id);
    if (!entry) return undefined;
    const [location, length, value] = entry;
    if (location !== 0 || length !== 1 || value === 32767 || !value) throw new Error('User-defined or invalid LAS GeoKey CRS. Declare a CRS.');
    return value;
  }
  const model = codeOf(1024);
  const code = model === 1 ? codeOf(3072) : model === 2 ? codeOf(2048) : undefined;
  if (!code) throw new Error('LAS GeoKeys have no resolvable horizontal CRS.');
  const unit = codeOf(model === 1 ? 3076 : 2054);
  if (unit != null && unit !== (model === 1 ? 9001 : 9102)) throw new Error('LAS GeoKeys horizontal unit conflicts with CRS metre / degree.');
  return { ...epsgReference(`EPSG:${code}`), description: `EPSG:${code} (LAS GeoKeys)` };
}

function checkCompression(file, header, records) {
  const vlrs = records.filter(record => record.userId === 'laszip encoded' && record.recordId === 22204);
  if (vlrs.length !== (header.compressed ? 1 : 0)) throw new Error('LAS compression flag conflicts with LASzip VLR.');
  if (!header.compressed) return;
  const format = header.pointDataRecordFormat;
  const bytes = vlrs[0].bytes;
  if (bytes.length < 34) throw new Error('LASzip VLR is too short.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressor = dv.getUint16(0, true);
  if (!(format < 6 ? [1, 2] : [3]).includes(compressor) || dv.getUint16(2, true) !== 0) {
    throw new Error('Inconsistent or unsupported LAZ compressor / coder.');
  }
  const items = format < 6 ? [[6, 20], ...([1, 3, 4, 5].includes(format) ? [[7, 8]] : []),
    ...([2, 3, 5].includes(format) ? [[8, 6]] : []), ...(format >= 4 ? [[9, 29]] : [])]
    : [[10, 30], ...(format === 7 ? [[11, 6]] : [8, 10].includes(format) ? [[12, 8]] : []), ...(format >= 9 ? [[13, 29]] : [])];
  const extra = header.pointDataRecordLength - lengths[format];
  if (extra) items.push([format < 6 ? 0 : 14, extra]);
  if (dv.getUint16(32, true) !== items.length || bytes.length !== 34 + items.length * 6 ||
      items.some(([type, size], i) => dv.getUint16(34 + i * 6, true) !== type ||
        dv.getUint16(36 + i * 6, true) !== size || !(format < 6 ? [1, 2] : [3, 4]).includes(dv.getUint16(38 + i * 6, true)))) {
      throw new Error(`Inconsistent or unsupported LAZ format ${format} item structure / version.`);
  }
  if (compressor === 1) return; // Pointwise compression has no chunk table.
  if (header.pointDataOffset + 8 > file.length) throw new Error('LAZ chunk table pointer is missing.');
  const fileView = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const table = safeUint64(fileView, fileView.getBigInt64(header.pointDataOffset, true) === -1n ? file.length - 8 : header.pointDataOffset);
  if (table < header.pointDataOffset + 8 || table + 8 > file.length || header.evlrCount && table + 8 > header.evlrOffset ||
      fileView.getUint32(table, true) !== 0 || !fileView.getUint32(table + 4, true)) {
    throw new Error('Invalid LAZ chunk table.');
  }
}

async function workerDecode(file, signal) {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./point-cloud-worker.js', import.meta.url), { type: 'module' });
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => data.error ? reject(new Error(`LAZ decode failed: ${data.error}`)) : resolve(data);
      worker.onmessageerror = () => reject(new Error('LAZ Worker result could not be received.'));
      worker.onerror = event => {
        event.preventDefault();
        reject(new Error(`LAZ Worker failed: ${event.message}`));
      };
      worker.postMessage(file.buffer, [file.buffer]);
    });
  } finally {
    signal?.removeEventListener('abort', abort);
    worker.terminate(); // Cancel synchronous decode and discard even a poisoned WASM instance.
  }
}

// decodeLaz is a Node-check injection, not a runtime codec fallback. Browsers always isolate WASM in a Worker.
export async function readPointCloud(url, { source, signal, srsName, decodeLaz } = {}) {
  signal?.throwIfAborted();
  if (!source) throw new Error('Point cloud requires a selected File source.');
  const response = await source.fetch(source.resolve(url), { signal });
  const file = new Uint8Array(await response.arrayBuffer());
  signal?.throwIfAborted();
  const header = headerOf(file), records = await recordsOf(file, header);
  checkCompression(file, header, records);
  const reference = referenceOf(records, header, srsName);
  const { pointCount: count, pointDataRecordFormat: format, pointDataRecordLength: length } = header;
  if (header.compressed && count * length > 2 ** 30) {
    throw new Error('LAZ raw records exceed the codec 1 GiB / call limit. All points are required; no sampling is performed.');
  }
  // ponytail: all points are held in memory, never sampled; use explicit chunk streaming if browser capacity is exceeded.
  let positions, colors;
  const rgbOffset = [undefined, undefined, 20, 28, undefined, 28, undefined, 30, 30, undefined, 30][format];
  let data;
  if (header.compressed) {
    const decoded = await (decodeLaz ? decodeLaz(file) : workerDecode(file, signal));
    signal?.throwIfAborted();
    if (decoded.count !== count || decoded.length !== length || decoded.format !== format ||
        !(decoded.points instanceof Uint8Array) || decoded.points.length !== count * length) {
      throw new Error('LAZ codec count / format / length conflicts with LAS header.');
    }
    data = decoded.points;
  } else data = file.subarray(header.pointDataOffset, header.pointDataOffset + count * length);
  try {
    positions = new Float64Array(count * 3);
    if (rgbOffset != null) colors = new Uint8Array(count * 3);
  } catch {
    throw new Error(`Point cloud of ${count} points exceeds browser array capacity; cannot allocate memory for all points.`);
  }
  // Reuse copc's scale/offset-aware getters. Waveform formats share the first XYZ bytes;
  // only their waveform payload is outside this viewer's point/RGB contract.
  const view = viewFormats.has(format) ? View.create(data, header, [], ['X', 'Y', 'Z', 'Red', 'Green', 'Blue']) : null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const xyz = ['X', 'Y', 'Z'].map((name, axis) => view ? view.getter(name)
    : index => dv.getInt32(index * length + axis * 4, true) * header.scale[axis] + header.offset[axis]);
  const rgb = colors && ['Red', 'Green', 'Blue'].map((name, axis) => view ? view.getter(name)
    : index => dv.getUint16(index * length + rgbOffset + axis * 2, true));
  for (let i = 0; i < count; i++) {
    if (i % 8192 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      signal?.throwIfAborted();
    }
    const source = xyz.map(get => get(i));
    if (!source.every(Number.isFinite)) throw new Error('LAS coordinates contain non-finite values.');
    const point = reference.toGeographic(source);
    if (point.length !== 3 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new Error('Converted LAS coordinates are non-finite or outside longitude/latitude bounds.');
    }
    positions.set(point, i * 3);
    if (rgb) colors.set(rgb.map(get => Math.round(get(i) / 257)), i * 3);
  }
  signal?.throwIfAborted();
  return { positions, count, ...(colors ? { colors } : {}),
    description: `${header.compressed ? 'LAZ' : 'LAS'} ${header.majorVersion}.${header.minorVersion} format ${format} · ${count} points · ${reference.description} · source elevation retained` };
}
