import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlateauSource, searchPlateau } from '../src/plateau.js';

const file = 'https://assets.cms.plateau.reearth.io/assets/80/45b2b1-5a88-40ab-9877-70b540b8707e/package/udx/ubld/53394653_ubld_6697_op.gml';
const tile = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13106-bldg-lod2-latest/tileset.json';

test('PLATEAU resources remain inside the selected package and official hosts', async () => {
  const source = createPlateauSource(file, 'gml');
  assert.equal(source.resolve('#wall'), file);
  assert.equal(source.resolve('neighbor.gml'), new URL('neighbor.gml', file).href);
  for (const reference of ['https://example.org/a.gml', '../../../other.gml', 'https://assets.cms.plateau.reearth.io/assets/ff/id/other/a.gml', '%2e%2e/secret.gml', '?token=secret']) {
    assert.throws(() => source.resolve(reference));
  }
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, file);
      assert.equal(options.redirect, 'error');
      return new Response('GML');
    };
    assert.equal(await (await source.fetch(file)).text(), 'GML');
  } finally { globalThis.fetch = originalFetch; source.dispose(); }
  assert.throws(() => source.resolve(file), /closed/);
  assert.throws(() => createPlateauSource(`${file}#part`, 'gml'), /Choose a PLATEAU GML/);
  const tiles = createPlateauSource(tile, 'tiles');
  const child = 'https://assets.cms.plateau.reearth.io/assets/80/45b2b1-5a88-40ab-9877-70b540b8707e/package/tileset.json';
  assert.equal(tiles.resolve(child), child);
  assert.equal(tiles.objectUrl(tiles.resolve('tile.glb', child)), new URL('tile.glb', child).href);
  assert.throws(() => tiles.resolve('https://elsewhere.invalid/tile.glb'));
});

test('catalog search returns selectable GML and Tiles without downloading models', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, 'error');
      if (url.endsWith('mm:53394653')) return Response.json({ cities: [{ cityName: 'Taito', files: { ubld: [{ code: '53394653', maxLod: 4, url: file }] }, featureTypes: { ubld: { name: 'Underground' } } }] });
      return Response.json({ latest_datasets: [{ city_code: '13106', format: '3D Tiles', name: 'Buildings', lod: '2', url: tile }, { city_code: '13101', format: '3D Tiles', url: tile }] });
    };
    assert.deepEqual((await searchPlateau('gml', '53394653')).map(item => item.url), [file]);
    assert.deepEqual((await searchPlateau('tiles', '13106')).map(item => item.url), [tile]);
    await assert.rejects(searchPlateau('gml', '13106'), /8-digit/);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});
