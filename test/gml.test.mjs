import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DOMParser } from '@xmldom/xmldom';
import * as THREE from 'three';
import { coordinateReference, localProjector } from '../src/coordinates.js';
import { loadGml as loadSelectedGml, parseGml as parseSelectedGml } from '../src/gml.js';
import { fixtureSource } from './fixture-source.mjs';
import { triangulateTin } from '../src/gml-tin.js';
import { palette, surfaces } from '../src/palette.js';

const base = 'http://localhost:8080/samples/gml/';
const source = fixtureSource(base);
const loadGml = (url, options = {}) => loadSelectedGml(url, { source, ...options });
const parseGml = (text, options = {}) => parseSelectedGml(text, { source, ...options });
const namespaces = 'xmlns:gml="http://www.opengis.net/gml" xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:gen="http://www.opengis.net/citygml/generics/2.0" xmlns:uro="https://www.geospatial.jp/iur/uro/3.2" xmlns:xlink="http://www.w3.org/1999/xlink"';
const wrap = geometry => `<core:CityModel ${namespaces} srsName="EPSG:6677" srsDimension="3"><core:cityObjectMember><gen:GenericCityObject gml:id="feature">${geometry}</gen:GenericCityObject></core:cityObjectMember></core:CityModel>`;
const point = (position = '0 0 4') => `<gml:Point><gml:pos>${position}</gml:pos></gml:Point>`;
const line = positions => `<gml:LineString><gml:posList>${positions}</gml:posList></gml:LineString>`;
const parse = (xml, options) => parseGml(xml, { url: `${base}check.gml`, ...options });
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const positionsOf = object => object.geometry.attributes.instanceStart?.data.array ?? object.geometry.attributes.position.array;
const verticesOf = object => object.geometry.attributes.instanceStart ? object.geometry.attributes.instanceStart.count * 2 : object.geometry.attributes.position.count;

test('GML profile: shapes, local refs, placements, per-feature LOD, common center, TIN, points and visible failures', async () => {
  const old = { DOMParser: globalThis.DOMParser, location: globalThis.location, fetch: globalThis.fetch };
  globalThis.DOMParser = DOMParser;
  globalThis.location = { href: 'http://localhost:8080/' };
  const profile = await readFile(new URL('./fixtures/gml/profile.gml', import.meta.url), 'utf8');
  const templates = await readFile(new URL('./fixtures/gml/templates.gml', import.meta.url), 'utf8');
  const calls = [];
  const documents = new Map([['profile.gml', profile], ['templates.gml', templates]]);
  let delayReferences = false;
  globalThis.fetch = async (url, options) => {
    options.signal?.throwIfAborted();
    const target = new URL(url);
    assert.equal(target.origin, 'http://localhost:8080');
    assert.equal(target.hash, '');
    assert.equal(options.redirect, 'error');
    calls.push(target.href);
    if (delayReferences && target.pathname.endsWith('/templates.gml')) {
      await new Promise(resolve => setTimeout(resolve, 20));
      options.signal?.throwIfAborted();
    }
    const document = documents.get(target.pathname.split('/').at(-1));
    return document === undefined ? new Response(null, { status: 404 }) : new Response(document);
  };
  const models = [];
  const remember = model => { models.push(model); return model; };
  try {
    const reference = coordinateReference({ srsName: 'EPSG:6677', dimension: 3 });
    const geo = reference.toGeographic([0, 0, 4]);
    const project = localProjector(geo);
    assert.equal(reference.hasElevation, true);
    assert.equal(coordinateReference({ srsName: 'EPSG:6677', dimension: 2 }).hasElevation, false);
    near(project(reference.toGeographic([0, 10, 4]))[0], 10, .002);
    near(project(reference.toGeographic([10, 0, 4]))[2], -10, .002);
    const model = remember(await loadGml(`${base}profile.gml`));
    assert.ok(model.group instanceof THREE.Group && model.bounds instanceof THREE.Box3);
    assert.equal(calls.filter(url => url.endsWith('templates.gml')).length, 1); // Shared document loaded once.
    assert.equal(model.group.children.length, 2);
    assert.match(model.description, /original rings \d+ \/ open lines 3 \/ segments \d+ \/ points 5/);
    assert.equal(model.group.children.find(child => child.isPoints).geometry.attributes.position.count, 5);
    assert.ok(model.bounds.getSize(new THREE.Vector3()).length() < 150); // No unreferenced million-unit template.
    assert.match(model.description, /2D.*height=0/);
    const positions = model.group.children.find(child => child.isPoints).geometry.attributes.position.array;
    const marker = project(reference.toGeographic([30, 40, 15]));
    const secondPoint = project(reference.toGeographic([0, 0, 4]));
    for (let axis = 0; axis < 3; axis++) near(positions[axis] - positions[axis + 3], marker[axis] - secondPoint[axis]);
    const linePositions = positionsOf(model.group.children.find(child => child.isLineSegments2));
    const placed = project(reference.toGeographic([60, 80, 13])); // Row-major matrix, then world anchor.
    assert.ok(Array.from({ length: linePositions.length / 3 }, (_, i) => i * 3).some(i =>
      [0, 1, 2].every(axis => Math.abs(linePositions[i + axis] - positions[axis] - (placed[axis] - marker[axis])) < .002)));
    const all = remember(await loadGml(`${base}profile.gml`, { lod: 'all' }));
    assert.notEqual(all.description, model.description);
    assert.ok(verticesOf(all.group.children.find(child => child.isLineSegments2)) > verticesOf(model.group.children.find(child => child.isLineSegments2)));
    const lod0 = remember(await loadGml(`${base}profile.gml`, { lod: 0 }));
    assert.match(lod0.description, /original rings 1 \/ open lines 0/);
    assert.equal(lod0.bounds.getSize(new THREE.Vector3()).y, 0);
    const lod1 = remember(await loadGml(`${base}profile.gml`, { lod: 1 }));
    assert.match(lod1.description, /LOD 1/);
    for (const lod of [3, 4]) await assert.rejects(loadGml(`${base}profile.gml`, { lod }), /No visible/);
    assert.equal(model.group.children.find(child => child.isPoints).material.size, 2);

    // Original ring edges, curve order and closures; no face diagonals or inferred point surfaces.
    const sample = await readFile(new URL('./fixtures/gml/sample.gml', import.meta.url), 'utf8');
    const building = remember(await parse(sample));
    assert.equal(verticesOf(building.group.children[0]), 56);
    assert.deepEqual(building.group.children.map(child => child.userData.surface), ['Unclassified']); // Neither height nor shape implies roof/wall.
    const open = remember(await parse(wrap(line('0 0 4 0 10 4 10 10 6'))));
    assert.equal(verticesOf(open.group.children[0]), 4);
    const shared = wrap(`<gml:MultiGeometry><gml:geometryMember>${point()}</gml:geometryMember><gml:geometryMember><gml:LineString><gml:pointProperty xlink:href="#shared-point"/><gml:pos>0 10 4</gml:pos></gml:LineString></gml:geometryMember></gml:MultiGeometry>`).replace('<gml:Point>', '<gml:Point gml:id="shared-point">');
    const sharedModel = remember(await parse(shared));
    assert.deepEqual([...positionsOf(sharedModel.group.children[0]).slice(0, 3)], [...positionsOf(sharedModel.group.children[1])]);
    const externalDefaults = wrap('<gen:lod1Geometry xlink:href="plain.gml#pc"/>');
    documents.set('plain.gml', `<gml:Dictionary ${namespaces}><gml:dictionaryEntry><gml:MultiPoint gml:id="pc"><gml:pointMember xlink:href="#p"/></gml:MultiPoint></gml:dictionaryEntry><gml:dictionaryEntry><gml:Point gml:id="p"><gml:pos>0 0 4</gml:pos></gml:Point></gml:dictionaryEntry></gml:Dictionary>`);
    remember(await parse(externalDefaults)); // Referring CRS survives traversal through an external collection and another ref.
    documents.set('context.gml', `<gml:Dictionary ${namespaces}><gml:dictionaryEntry><gml:Point gml:id="p"><gml:pos>0 10 4</gml:pos></gml:Point></gml:dictionaryEntry></gml:Dictionary>`);
    const contexts = remember(await parse(wrap('<gml:MultiPoint><gml:pointMember axisLabels="northing easting height" xlink:href="context.gml#p"/><gml:pointMember axisLabels="easting northing height" xlink:href="context.gml#p"/></gml:MultiPoint>')));
    assert.ok(contexts.bounds.getSize(new THREE.Vector3()).x > 9.9 && contexts.bounds.getSize(new THREE.Vector3()).z > 9.9); // Cached local Envelope lookup cannot cache a referring property's CRS/axis context.
    const localBase = remember(await parse(externalDefaults.replace('<core:CityModel ', '<core:CityModel xml:base="refs/" ')));
    assert.equal(calls.at(-1), `${base}refs/plain.gml`);
    assert.equal(localBase.group.children.find(child => child.isPoints).geometry.attributes.position.count, 1);
    await assert.rejects(parse(externalDefaults.replace('<core:CityModel ', '<core:CityModel xml:base="/" ').replace('plain.gml#pc', 'samples/gml/plain.gml#pc')), /Input must/);
    remember(await parse(externalDefaults.replace('<core:CityModel ', '<core:CityModel xml:base="assets/" ').replace('<gen:lod1Geometry ', '<gen:lod1Geometry xml:base="../refs/nested/" ').replace('plain.gml#pc', '../plain.gml#pc')));
    assert.equal(calls.at(-1), `${base}refs/plain.gml`); // Root + property bases use RFC hierarchical resolution.
    const basedLibrary = wrap(`<core:ImplicitGeometry xml:base="refs/"><core:libraryObject xml:base="../templates.gml">#prototype</core:libraryObject><core:referencePoint>${point()}</core:referencePoint></core:ImplicitGeometry>`);
    const prototype = remember(await parse(basedLibrary));
    assert.equal(calls.at(-1), `${base}templates.gml`);
    assert.match(prototype.description, /original rings 1/);
    const surface = '<gml:Polygon gml:id="surface"><gml:exterior><gml:LinearRing><gml:posList>0 0 0 0 10 0 10 10 0 0 0 0</gml:posList></gml:LinearRing></gml:exterior></gml:Polygon>';
    const multiSurface = `<gml:MultiSurface><gml:surfaceMember>${surface.replace(' gml:id="surface"', '')}</gml:surfaceMember></gml:MultiSurface>`;
    const room = `<bldg:Room gml:id="room"><bldg:lod4MultiSurface>${multiSurface}</bldg:lod4MultiSurface></bldg:Room>`;
    const nestedBuilding = wrap(`<bldg:lod1MultiSurface>${multiSurface}</bldg:lod1MultiSurface><bldg:interiorRoom>${room}</bldg:interiorRoom>`)
      .replace('xmlns:gen=', 'xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:gen=').replaceAll('gen:GenericCityObject', 'bldg:Building').replace('gml:id="feature"', 'gml:id="outer"');
    const ringCount = model => Number(model.description.match(/original rings (\d+)/)[1]);
    assert.equal(ringCount(remember(await parse(nestedBuilding))), 2); // A Room cannot suppress its Building.
    const furnished = nestedBuilding.replace('</bldg:Room>', `<bldg:interiorFurniture><bldg:BuildingFurniture gml:id="chair"><bldg:lod4Geometry>${point()}</bldg:lod4Geometry></bldg:BuildingFurniture></bldg:interiorFurniture><bldg:roomInstallation><bldg:IntBuildingInstallation gml:id="fan"><bldg:lod4Geometry>${point()}</bldg:lod4Geometry></bldg:IntBuildingInstallation></bldg:roomInstallation></bldg:Room>`)
      .replace('</bldg:Building>', `<bldg:outerBuildingInstallation><bldg:BuildingInstallation gml:id="lamp"><bldg:lod2Geometry>${point()}</bldg:lod2Geometry></bldg:BuildingInstallation></bldg:outerBuildingInstallation></bldg:Building>`);
    assert.match(remember(await parse(furnished)).description, /original rings 2 .* points 3/);
    documents.set('room.gml', room.replace('<bldg:Room ', `<bldg:Room ${namespaces} xmlns:bldg="http://www.opengis.net/citygml/building/2.0" `));
    assert.equal(ringCount(remember(await parse(nestedBuilding.replace(`<bldg:interiorRoom>${room}</bldg:interiorRoom>`, '<bldg:interiorRoom xlink:href="room.gml#room"/>')))), 2); // The same owner boundary for xlink.
    for (const namespace of ['https://www.geospatial.jp/iur/uro/3.2', 'http://www.kantei.go.jp/jp/singi/tiiki/toshisaisei/itoshisaisei/iur/uro/1.4']) {
      const declared = wrap(`<uro:lod0Geometry>${point()}</uro:lod0Geometry><uro:lod1Geometry>${point('0 10 5')}</uro:lod1Geometry>`).replace('https://www.geospatial.jp/iur/uro/3.2', namespace);
      assert.match(remember(await parse(declared)).description, /points 1/);
      assert.match(remember(await parse(declared, { lod: 'all' })).description, /points 2/);
      assert.match(remember(await parse(declared, { lod: 0 })).description, /points 1/);
    }
    const surfaceRef = remember(await parse(wrap(`<gml:metaDataProperty><gml:Dictionary><gml:dictionaryEntry>${surface}</gml:dictionaryEntry></gml:Dictionary></gml:metaDataProperty><gen:lod2Geometry><gml:MultiSurface><gml:surfaceMember xlink:href="#surface"/></gml:MultiSurface></gen:lod2Geometry>`)));
    assert.equal(verticesOf(surfaceRef.group.children[0]), 6); // Referenced surface only, not declaration + use.
    const bldg = 'xmlns:bldg="http://www.opengis.net/citygml/building/2.0"';
    const wallFace = surface.replace('gml:id="surface"', 'gml:id="wall-face"');
    const uniqueFace = surface.replace('gml:id="surface"', 'gml:id="unique-face"').replaceAll('10', '12');
    const duplicated = wrap(`<bldg:boundedBy><bldg:WallSurface><bldg:lod4MultiSurface><gml:MultiSurface><gml:surfaceMember>${wallFace}</gml:surfaceMember></gml:MultiSurface></bldg:lod4MultiSurface></bldg:WallSurface></bldg:boundedBy><bldg:lod4Solid><gml:Solid><gml:exterior><gml:CompositeSurface><gml:surfaceMember xlink:href="#wall-face"/><gml:surfaceMember>${uniqueFace}</gml:surfaceMember></gml:CompositeSurface></gml:exterior></gml:Solid></bldg:lod4Solid>`).replace('xmlns:gen=', `${bldg} xmlns:gen=`).replaceAll('gen:GenericCityObject', 'bldg:Building');
    const deduped = remember(await parse(duplicated));
    assert.deepEqual(deduped.group.children.map(child => child.userData.surface), ['WallSurface', 'Unclassified'], 'solid xlink does not redraw a classified face, but preserves unique faces');
    assert.match(deduped.description, /original rings 2 .* segments 6/);
    assert.equal(ringCount(remember(await parse(duplicated, { lod: 'all' }))), 2);
    const withHole = duplicated.replace(wallFace, wallFace.replace('</gml:Polygon>', '<gml:interior><gml:LinearRing><gml:posList>2 2 0 2 4 0 4 2 0 2 2 0</gml:posList></gml:LinearRing></gml:interior></gml:Polygon>'));
    assert.equal(ringCount(remember(await parse(withHole))), 3, 'exterior and interior rings stay distinct');
    const sharedAcrossFeatures = duplicated.replace('</core:CityModel>', `<core:cityObjectMember><bldg:Building gml:id="second"><bldg:boundedBy><bldg:WallSurface><bldg:lod4MultiSurface><gml:MultiSurface><gml:surfaceMember xlink:href="#wall-face"/></gml:MultiSurface></bldg:lod4MultiSurface></bldg:WallSurface></bldg:boundedBy></bldg:Building></core:cityObjectMember></core:CityModel>`);
    assert.equal(ringCount(remember(await parse(sharedAcrossFeatures))), 2, 'a shared face is not overdrawn by another feature');
    documents.set('semantic.gml', `<gml:Dictionary ${namespaces}><gml:dictionaryEntry>${surface}</gml:dictionaryEntry></gml:Dictionary>`);
    const member = href => `<gml:MultiSurface><gml:surfaceMember xlink:href="${href}"/></gml:MultiSurface>`;
    const typed = type => `<bldg:${type}><bldg:lod2MultiSurface>${member('#surface')}</bldg:lod2MultiSurface></bldg:${type}>`;
    const wall = `<bldg:WallSurface><bldg:lod2MultiSurface>${member('#surface')}</bldg:lod2MultiSurface><bldg:opening><bldg:Door><bldg:lod2MultiSurface>${member('semantic.gml#surface')}</bldg:lod2MultiSurface></bldg:Door></bldg:opening></bldg:WallSurface>`;
    const installation = `<bldg:IntBuildingInstallation><bldg:lod2ImplicitRepresentation><core:ImplicitGeometry><core:relativeGMLGeometry xlink:href="templates.gml#prototype"/><core:referencePoint>${point()}</core:referencePoint></core:ImplicitGeometry></bldg:lod2ImplicitRepresentation></bldg:IntBuildingInstallation>`;
    const semanticXml = wrap(`<gml:metaDataProperty><gml:Dictionary><gml:dictionaryEntry>${surface}</gml:dictionaryEntry></gml:Dictionary></gml:metaDataProperty>${wall}${installation}${surfaces.filter(([name]) => !['Unclassified', 'WallSurface', 'Door', 'IntBuildingInstallation'].includes(name)).map(([name]) => typed(name)).join('')}${point()}`).replace('xmlns:gen=', `${bldg} xmlns:gen=`);
    const semantic = remember(await parse(semanticXml));
    assert.deepEqual(new Set(semantic.group.children.map(child => child.userData.surface)), new Set(surfaces.map(([name]) => name)));
    assert.ok(calls.includes(`${base}semantic.gml`));
    assert.ok(semantic.group.children.length <= surfaces.length); // One batch per type/topology, never per ring.
    const beforeSemanticBounds = semantic.bounds.clone(), beforeSemanticCalls = calls.length;
    const beforeSemanticGeometry = semantic.group.children.map(child => child.geometry);
    const styledLine = semantic.group.children.find(child => child.isLineSegments2);
    const testCamera = new THREE.PerspectiveCamera(45, 4 / 3, .1, 1000), center = semantic.bounds.getCenter(new THREE.Vector3());
    testCamera.position.copy(center).add(new THREE.Vector3(0, 0, 500));
    semantic.update(testCamera, { getSize: vector => vector.set(800, 600) });
    const farWidth = styledLine.material.linewidth;
    assert.ok(farWidth <= .3, 'wide-view lines stay hairline thin');
    testCamera.position.copy(center).add(new THREE.Vector3(0, 0, 5));
    semantic.update(testCamera, { getSize: vector => vector.set(800, 600) });
    assert.ok(styledLine.material.linewidth > farWidth, 'wide view uses thinner screen-space lines without changing geometry');
    assert.ok(styledLine.material.linewidth <= .85, 'close-up lines never become heavy');
    const extent = semantic.bounds.getSize(new THREE.Vector3()).length();
    const ortho = new THREE.OrthographicCamera(-extent, extent, extent, -extent, .1, 1000);
    semantic.update(ortho, { getSize: vector => vector.set(800, 600) });
    const orthoWidth = styledLine.material.linewidth;
    ortho.zoom = 4;
    semantic.update(ortho, { getSize: vector => vector.set(800, 600) });
    assert.ok(styledLine.material.linewidth > orthoWidth, 'orthographic zoom also adapts linewidth');
    for (const theme of ['dark', 'light']) {
      semantic.setTheme(theme);
      for (const child of semantic.group.children) assert.equal(child.material.color.getHexString(), palette(theme)(child.userData.surface).slice(1));
    }
    assert.notEqual(palette('dark')('IntBuildingInstallation'), palette('light')('IntBuildingInstallation'));
    assert.equal(palette('dark')('IntBuildingInstallation'), '#ffd166'); // Yellow means all internal installations.
    assert.ok(semantic.bounds.equals(beforeSemanticBounds));
    assert.equal(calls.length, beforeSemanticCalls);
    semantic.group.children.forEach((child, i) => assert.equal(child.geometry, beforeSemanticGeometry[i]));
    documents.set('shape.gml', `<gml:LineString ${namespaces}><gml:posList>0 0 0 2 0 0</gml:posList></gml:LineString>`);
    remember(await parse(wrap(`<core:ImplicitGeometry><core:libraryObject>shape.gml</core:libraryObject><core:referencePoint>${point()}</core:referencePoint></core:ImplicitGeometry>`)));
    const relative2DAnchor = remember(await parse(wrap(`<core:ImplicitGeometry><core:relativeGMLGeometry>${line('0 0 1 2 0 3')}</core:relativeGMLGeometry><core:referencePoint><gml:Point srsDimension="2"><gml:pos>0 0</gml:pos></gml:Point></core:referencePoint></core:ImplicitGeometry>`)));
    near(relative2DAnchor.bounds.getSize(new THREE.Vector3()).y, 2);
    assert.match(relative2DAnchor.description, /2D.*height=0/);
    remember(await parse(wrap(`<uro:lod1HeightType>metadata-only</uro:lod1HeightType>${point()}`))); // LOD-prefixed metadata is not geometry.
    remember(await parse(`<gml:FeatureCollection ${namespaces} srsName="EPSG:6677" srsDimension="3"><gml:featureMember><gen:GenericCityObject>${point()}</gen:GenericCityObject></gml:featureMember></gml:FeatureCollection>`));

    // A real constrained TIN: enforce breaklines, split crossings / T-junctions, stoplines and maxLength.
    const controls = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];
    const triangles = triangulateTin(controls, [[controls[0], controls[2]]], [], 20);
    assert.equal(triangles.length, 2);
    assert.ok(triangles.every(triangle => triangle.points.some(p => p === controls[0]) && triangle.points.some(p => p === controls[2])));
    const crossing = triangulateTin(controls, [[controls[0], controls[2]], [controls[1], controls[3]]], [], 20);
    assert.equal(crossing.length, 4);
    assert.ok(crossing.every(triangle => triangle.points.some(p => p[0] === 5 && p[2] === 5)));
    assert.equal(triangulateTin(controls, [[controls[0], controls[2]]], [[[1, 0, 8], [2, 0, 8]]], 20).length, 1);
    const singleTriangle = [controls[0], controls[1], controls[3]];
    assert.equal(triangulateTin(singleTriangle, [], [[singleTriangle[0], singleTriangle[1]]], 100).length, 1); // Reviewer reproduction: shared edge.
    assert.equal(triangulateTin(singleTriangle, [], [[[-2, 0, -2], [0, 0, 0]]], 100).length, 1); // Vertex touch.
    assert.equal(triangulateTin(singleTriangle, [], [[...singleTriangle, singleTriangle[0]]], 100).length, 1); // Closed boundary, no crossings.
    assert.equal(triangulateTin(singleTriangle, [], [[[-1, 0, -1], [12, 0, -1], [12, 0, 12], [-1, 0, 12], [-1, 0, -1]]], 100).length, 1); // Enclosed does not mean excluded region.
    assert.throws(() => triangulateTin(singleTriangle, [], [[[0, 0, 5], [5, 0, 0]]], 100), /TIN constraints/); // Both endpoints on boundary, chord crosses interior.
    assert.throws(() => triangulateTin(singleTriangle, [], [[[1, 0, 1], [2, 0, 1], [2, 0, 2], [1, 0, 1]]], 100), /TIN constraints/); // Inner closed stopline crosses the triangle interior.
    assert.throws(() => triangulateTin(controls, [], [], 5), /TIN constraints/);
    assert.throws(() => triangulateTin([[0, 0, 0], [0, 1, 0], [10, 0, 0]], [], [], 20), /Different elevations/);

    // Shared LAS path: one-point synthetic LAS 1.2, RGB + mixed inline point + line, one common origin/center.
    const las = new Uint8Array(253), dv = new DataView(las.buffer);
    las.set(new TextEncoder().encode('LASF')); las[24] = 1; las[25] = 2;
    dv.setUint16(94, 227, true); dv.setUint32(96, 227, true); las[104] = 2;
    dv.setUint16(105, 26, true); dv.setUint32(107, 1, true);
    for (let axis = 0; axis < 3; axis++) dv.setFloat64(131 + axis * 8, 1, true);
    [10, 0, 4].forEach((value, axis) => { dv.setInt32(227 + axis * 4, value, true); dv.setFloat64(179 + axis * 16, value, true); dv.setFloat64(187 + axis * 16, value, true); });
    dv.setUint16(247, 65535, true);
    documents.set('synthetic.las', las);
    const withLas = remember(await parse(wrap(`${point()}${line('0 0 4 0 10 4')}<uro:pointCloud><uro:PointCloud><uro:pointFile>synthetic.las</uro:pointFile><uro:pointFileSrsName>EPSG:6677</uro:pointFileSrsName></uro:PointCloud></uro:pointCloud>`)));
    const lineArray = positionsOf(withLas.group.children[0]), cloudGeometry = withLas.group.children[1].geometry;
    assert.deepEqual([...lineArray.slice(3, 6)], [...positionsOf(withLas.group.children[2])]);
    assert.equal(cloudGeometry.getAttribute('color'), undefined);
    assert.deepEqual([...withLas.group.children[2].geometry.attributes.color.array], [255, 0, 0]);
    assert.equal(cloudGeometry.attributes.position.count + withLas.group.children[2].geometry.attributes.position.count, 2);
    const cloudPosition = withLas.group.children[2].geometry.attributes.position.array;
    assert.notDeepEqual([...cloudPosition], [...cloudGeometry.attributes.position.array]); // No point is moved to infer a surface.
    const beforeTheme = withLas.bounds.clone(), beforeCalls = calls.length;
    const originalGeometry = withLas.group.children.map(child => [child.geometry, [...positionsOf(child)]]);
    withLas.setTheme('light');
    assert.equal(withLas.group.children[0].material.color.getHexString(), palette('light')('Unclassified').slice(1));
    assert.equal(withLas.group.children[1].material.color.getHexString(), palette('light')('Unclassified').slice(1));
    assert.equal(withLas.group.children[2].material.color.getHex(), 0xffffff);
    assert.deepEqual([...withLas.group.children[2].geometry.attributes.color.array], [255, 0, 0]);
    assert.ok(withLas.bounds.equals(beforeTheme));
    assert.equal(calls.length, beforeCalls);
    withLas.group.children.forEach((child, i) => { assert.equal(child.geometry, originalGeometry[i][0]); assert.deepEqual([...positionsOf(child)], originalGeometry[i][1]); });
    withLas.setTheme('dark');
    const basedPointFile = wrap('<uro:PointCloud xml:base="assets/"><uro:pointFile xml:base="../point-files/">synthetic.las</uro:pointFile><uro:pointFileSrsName>EPSG:6677</uro:pointFileSrsName></uro:PointCloud>');
    const basedCloud = remember(await parse(basedPointFile));
    assert.equal(calls.at(-1), `${base}point-files/synthetic.las`);
    assert.match(basedCloud.description, /LAS 1\.2 format 2/);
    const beforeBaseRejection = calls.length;
    for (const xml of [externalDefaults, basedLibrary, basedPointFile]) {
      await assert.rejects(parse(xml.replace('<core:CityModel ', '<core:CityModel xml:base="https://outside.invalid/data/" ')), /External URLs/);
      await assert.rejects(parse(xml.replace('<core:CityModel ', '<core:CityModel xml:base="/outside/" ')), /Input must/);
    }
    assert.equal(calls.length, beforeBaseRejection); // No external or out-of-scope base reaches fetch.

    // Broken refs, cycles, unknown shapes and malformed non-selected LOD cannot be silently discarded.
    documents.set('cycle.gml', `<gml:MultiGeometry ${namespaces} gml:id="cycle"><gml:geometryMember xlink:href="check.gml#cycle"/></gml:MultiGeometry>`);
    const failures = [
      [wrap('<gen:lod2Geometry xlink:href="#missing"/>'), /not found/],
      [wrap('<gen:lod2Geometry xlink:href="https://outside.invalid/data/a.gml#p"/>'), /External URLs/],
      [wrap('<gen:lod2Geometry xlink:href="/outside.gml#p"/>'), /Input must/],
      [wrap('<gen:lod2Geometry xlink:href="templates.gml"/>'), /reference ID/],
      [wrap('<gen:lod2Geometry xlink:href="missing.gml#p"/>'), /HTTP 404/],
      [`<gml:MultiGeometry ${namespaces} gml:id="cycle"><gml:geometryMember xlink:href="#cycle"/></gml:MultiGeometry>`, /Cyclic/],
      [`<gml:MultiGeometry ${namespaces} gml:id="cycle"><gml:geometryMember xlink:href="cycle.gml#cycle"/></gml:MultiGeometry>`, /Cyclic/],
      [wrap('<gml:FutureSurface><gml:pos>0 0 0</gml:pos></gml:FutureSurface>'), /Unsupported/],
      [wrap(`<uro:PointCloud><uro:points><gml:MultiPoint><gml:pointMember>${point()}</gml:pointMember></gml:MultiPoint></uro:points><uro:unknownGeometry>${point()}</uro:unknownGeometry></uro:PointCloud>`), /uro:points/],
      [wrap('<gml:Curve><gml:segments><gml:Arc><gml:posList>0 0 0 0 1 0 1 1 0</gml:posList></gml:Arc></gml:segments></gml:Curve>'), /Unsupported/],
      [wrap(`<gen:lod0Geometry><gml:FutureSurface/></gen:lod0Geometry><gen:lod2Geometry>${point()}</gen:lod2Geometry>`), /Unsupported/],
      [wrap('<gen:lod2Geometry/>'), /no geometry/],
      [wrap(`<gen:lod5Geometry>${point()}</gen:lod5Geometry>`), /LOD/],
      [wrap('<gml:LinearRing><gml:posList>0 0 0 0 10 0 10 10 0 10 0 0</gml:posList></gml:LinearRing>'), /not closed/],
      [wrap('<gml:LineString><gml:posList count="3">0 0 0 1 1 1</gml:posList></gml:LineString>'), /count/],
      [wrap(point('0 0 Infinity')), /numbers/],
      [wrap(point('0 0 0')).replace('EPSG:6677', 'EPSG:99999'), /CRS/],
      [wrap(`<core:ImplicitGeometry><core:transformationMatrix>1 2</core:transformationMatrix><core:relativeGMLGeometry>${line('0 0 0 1 0 0')}</core:relativeGMLGeometry><core:referencePoint>${point()}</core:referencePoint></core:ImplicitGeometry>`), /16 row-major/],
      [wrap(`<core:ImplicitGeometry><core:transformationMatrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0</core:transformationMatrix><core:relativeGMLGeometry>${line('0 0 0 1 0 0')}</core:relativeGMLGeometry><core:referencePoint>${point()}</core:referencePoint></core:ImplicitGeometry>`), /w=0/],
      [wrap('<core:ImplicitGeometry><core:libraryObject>object.obj</core:libraryObject><core:referencePoint><gml:Point><gml:pos>0 0 0</gml:pos></gml:Point></core:referencePoint></core:ImplicitGeometry>'), /OBJ/],
      ['<!DOCTYPE a><a/>', /DTD/], ['<a><b></a>', /XML syntax/],
      [wrap(`<gen:lod1Geometry xlink:href="#p">${point()}</gen:lod1Geometry>`), /conflicting/],
      [wrap(`${point()}${point()}`).replaceAll('<gml:Point>', '<gml:Point gml:id="duplicate">'), /Duplicate/],
    ];
    for (const [xml, expected] of failures) await assert.rejects(parse(xml), expected);
    await assert.rejects(parse(wrap(point()), { lod: '2' }), /LOD/);
    await assert.rejects(loadGml(`${base}missing.gml`), /HTTP 404/);
    const controller = new AbortController(); controller.abort();
    const before = calls.length;
    await assert.rejects(parse(profile, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(calls.length, before);
    const loading = new AbortController();
    delayReferences = true;
    setTimeout(() => loading.abort(), 0);
    await assert.rejects(parse(profile, { signal: loading.signal }), { name: 'AbortError' });
    delayReferences = false;
    let disposed = 0;
    model.group.children.forEach(child => { child.geometry.addEventListener('dispose', () => disposed++); child.material.addEventListener('dispose', () => disposed++); });
    model.dispose();
    assert.equal(disposed, 4);
    assert.equal(model.group.children.length, 0);
  } finally {
    models.forEach(model => { if (model.group.children.length) model.dispose(); });
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
