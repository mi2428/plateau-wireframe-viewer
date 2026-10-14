import proj4 from 'proj4';

const geographic = '+proj=longlat +ellps=GRS80 +no_defs';
const planeOrigins = [
  [33, 129.5], [33, 131], [36, 132 + 10 / 60], [33, 133.5],
  [36, 134 + 20 / 60], [36, 136], [36, 137 + 10 / 60], [36, 138.5],
  [36, 139 + 50 / 60], [40, 140 + 50 / 60], [44, 140.25],
  [44, 142.25], [44, 144.25], [26, 142], [26, 127.5], [26, 124],
  [26, 131], [20, 136], [26, 154],
];
const axisNames = {
  lat: 'latitude', latitude: 'latitude', lon: 'longitude', long: 'longitude', longitude: 'longitude',
  n: 'northing', north: 'northing', northing: 'northing',
  e: 'easting', east: 'easting', easting: 'easting',
  h: 'height', height: 'height', alt: 'height', altitude: 'height',
};

function epsgCode(name) {
  const match = String(name ?? '').trim().match(/^(?:EPSG:|urn:(?:x-)?ogc:def:crs:EPSG:[^:]*:|https?:\/\/www\.opengis\.net\/def\/crs\/EPSG\/[^/]+\/|https?:\/\/www\.opengis\.net\/gml\/srs\/epsg\.xml#)(\d+)$/i);
  if (!match) throw new Error(`Unsupported srsName: ${name || '(missing)'}`);
  return Number(match[1]);
}

function validateGeographic(point) {
  if (point.length !== 3 || !point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
    throw new Error('Converted coordinates are non-finite or outside longitude/latitude bounds.');
  }
  return point;
}

// EPSG geographic axes are latitude/longitude; Japanese plane axes are northing/easting.
export function coordinateReference({ srsName, dimension, axisLabels } = {}) {
  const code = epsgCode(srsName);
  const plane = code >= 6669 && code <= 6687;
  if (!plane && ![4326, 6668, 6697].includes(code)) throw new Error(`Unsupported CRS: EPSG:${code}`);
  const dim = Number(dimension ?? (code === 6697 ? 3 : 2));
  if (![2, 3].includes(dim)) throw new Error(`Unsupported coordinate dimension for EPSG:${code}: ${dimension}`);
  if (code === 6697 && dim !== 3) throw new Error('EPSG:6697 is a 3D compound CRS with elevation; srsDimension=2 is inconsistent.');
  const hasElevation = dim === 3;
  const defaults = (plane ? ['northing', 'easting', 'height'] : ['latitude', 'longitude', 'height']).slice(0, dim);
  const labels = plane ? { ...axisNames, x: 'northing', y: 'easting', z: 'height' } : axisNames;
  const axes = axisLabels == null ? defaults
    : axisLabels.trim().split(/\s+/).map(label => labels[label.toLowerCase()]);
  if (axes.length !== dim || new Set(axes).size !== dim || axes.some(axis => !defaults.includes(axis))) {
    throw new Error(`Unsupported or inconsistent axisLabels: ${axisLabels}`);
  }
  let source = code === 4326 ? '+proj=longlat +datum=WGS84 +no_defs' : geographic;
  if (plane) {
    const [lat, lon] = planeOrigins[code - 6669];
    source = `+proj=tmerc +lat_0=${lat} +lon_0=${lon} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`;
  }
  const converter = proj4(source, geographic);
  return {
    code, dimension: dim, hasElevation,
    toGeographic(values) {
      if (values.length !== dim || !values.every(Number.isFinite)) throw new Error('Coordinate dimension is inconsistent or values are non-finite.');
      const horizontal = plane ? ['easting', 'northing'] : ['longitude', 'latitude'];
      const xy = horizontal.map(axis => values[axes.indexOf(axis)]);
      const height = hasElevation ? values[axes.indexOf('height')] : 0;
      if (!plane) validateGeographic([...xy, height]);
      const [lon, lat] = converter.forward(xy);
      // Keep the supplied height: no geoid conversion and no artificial floors.
      return validateGeographic([lon, lat, height]);
    },
  };
}

export function localProjector(origin) {
  validateGeographic(origin);
  const converter = proj4(geographic, `+proj=tmerc +lat_0=${origin[1]} +lon_0=${origin[0]} +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`);
  return point => {
    validateGeographic(point);
    const [east, north] = converter.forward(point.slice(0, 2));
    const local = [east, point[2], -north]; // Right-handed Y-up: east / height / south.
    if (!local.every(Number.isFinite)) throw new Error('Local coordinate conversion returned non-finite values.');
    return local;
  };
}
