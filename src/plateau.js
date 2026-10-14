const catalog = 'https://api.plateauview.mlit.go.jp';
const assets = 'https://assets.cms.plateau.reearth.io';
const assetPath = /^\/assets\/[a-f\d]{2}\/[a-f\d-]+\/[^/]+\//i;

function approved(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.protocol !== 'https:') throw new Error('Invalid PLATEAU resource URL.');
  if (url.origin === assets && assetPath.test(url.pathname)) return url;
  throw new Error('Resource is outside PLATEAU assets.');
}

export function createPlateauSource(value, kind, name) {
  if (!['gml', 'tiles'].includes(kind)) throw new Error('Unsupported PLATEAU dataset.');
  const root = new URL(value);
  if (kind === 'gml') {
    approved(root.href);
    if (root.search || root.hash || !/\.gml$/i.test(root.pathname)) throw new Error('Choose a PLATEAU GML.');
  } else if (root.origin !== catalog || !/^\/datacatalog\/3dtiles\/[\w-]+\/tileset\.json$/.test(root.pathname) || root.search || root.hash) {
    throw new Error('Choose a PLATEAU 3D Tiles catalog entry.');
  }
  let closed = false;
  const source = {
    url: root.href,
    name: name || root.pathname.split('/').at(-1),
    resolve(value, base = root.href) {
      if (closed) throw new Error('PLATEAU selection is closed.');
      if (String(value).includes('\\') || /%(?:2e|2f|5c)/i.test(value)) throw new Error('Invalid PLATEAU resource path.');
      const parent = new URL(base);
      const url = new URL(value, parent);
      url.hash = '';
      if (url.href === root.href) return url.href;
      approved(url.href);
      // A referenced file cannot climb into another package, even on the same host.
      if (parent.origin === assets && !url.pathname.startsWith(parent.pathname.match(assetPath)?.[0] || '/INVALID/')) {
        throw new Error('Reference escapes the PLATEAU package.');
      }
      return url.href;
    },
    async fetch(value, { signal } = {}) {
      const url = source.resolve(value);
      signal?.throwIfAborted();
      const response = await fetch(url, { signal, redirect: 'error' });
      if (!response.ok) throw new Error(`PLATEAU download failed (${response.status}): ${url}`);
      return response;
    },
    // Three's loaders use synchronous URL modifiers for glTF buffers and textures.
    objectUrl(value) { return source.resolve(value); },
    ownsObjectUrl() { return false; },
    dispose() { closed = true; },
  };
  return source;
}

export async function searchPlateau(kind, code, signal) {
  if (kind === 'gml' && !/^\d{8}$/.test(code)) throw new Error('Enter an 8-digit mesh code.');
  if (kind === 'tiles' && !/^\d{5}$/.test(code)) throw new Error('Enter a 5-digit municipality code.');
  if (!['gml', 'tiles'].includes(kind)) throw new Error('Choose CityGML or 3D Tiles.');
  const endpoint = kind === 'gml' ? `${catalog}/datacatalog/citygml/mm:${code}` : `${catalog}/datacatalog/plateau-datasets`;
  const response = await fetch(endpoint, { signal, redirect: 'error' });
  if (!response.ok) throw new Error(`PLATEAU catalog failed (${response.status}).`);
  const data = await response.json();
  signal?.throwIfAborted();
  if (kind === 'tiles') {
    if (!Array.isArray(data.latest_datasets)) throw new Error('Invalid PLATEAU catalog response.');
    return data.latest_datasets.filter(item => item.city_code === code && item.format === '3D Tiles')
      .map(item => ({ kind, url: item.url, label: `${item.name} · LOD ${item.lod}${item.texture ? ' · texture' : ''}` }));
  }
  if (!Array.isArray(data.cities)) throw new Error('Invalid PLATEAU catalog response.');
  return data.cities.flatMap(city => Object.entries(city.files || {}).flatMap(([type, files]) =>
    files.map(file => ({ kind, url: file.url, label: `${city.cityName} · ${city.featureTypes?.[type]?.name || type} · ${file.code} · LOD ${file.maxLod} · ${new URL(file.url).pathname.split('/').at(-1)}` }))));
}
