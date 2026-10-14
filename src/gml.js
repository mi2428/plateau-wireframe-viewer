import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { coordinateReference, localProjector } from './coordinates.js';
import { triangulateTin } from './gml-tin.js';
import { palette, semanticType } from './palette.js';

const gmlNamespaces = new Set(['http://www.opengis.net/gml', 'http://www.opengis.net/gml/3.2']);
const xlinkNamespace = 'http://www.w3.org/1999/xlink';
const isGml = (node, name) => gmlNamespaces.has(node.namespaceURI) && (!name || node.localName === name);
const isCity = node => /^http:\/\/www\.opengis\.net\/citygml(?:\/[^/]+)?\/2\.0$/.test(node.namespaceURI);
const isUro = node => /^(?:https?:\/\/www\.geospatial\.jp\/iur\/uro|http:\/\/www\.kantei\.go\.jp\/jp\/singi\/tiiki\/toshisaisei\/itoshisaisei\/iur\/uro)\/\d+(?:\.\d+)*$/.test(node.namespaceURI);
const children = node => Array.from(node.childNodes).filter(child => child.nodeType === 1);
const attribute = (node, name) => node.hasAttribute(name) ? node.getAttribute(name) : undefined;
const hrefOf = node => node.hasAttributeNS(xlinkNamespace, 'href') ? node.getAttributeNS(xlinkNamespace, 'href') : undefined;
const idOf = node => [...gmlNamespaces].map(ns => node.getAttributeNS(ns, 'id')).find(Boolean);
const samePoint = (a, b) => a.every((value, axis) => Math.abs(value - b[axis]) < 1e-7);
const metadataNames = new Set(['metaDataProperty', 'description', 'descriptionReference', 'name', 'identifier', 'boundedBy']);
const nonShapeNames = new Set(['Dictionary', 'Definition', 'Envelope', 'TimePeriod', 'TimeInstant']);
const nonDrawingProperties = new Set(['appearance', 'appearanceMember', 'externalReference', 'generalizesTo', 'xalAddress']);
const ownerProperties = new Set([
  'cityObjectMember', 'featureMember', 'featureMembers', 'consistsOfBuildingPart', 'consistsOfBridgePart', 'consistsOfTunnelPart', 'reliefComponent',
  'interiorRoom', 'interiorFurniture', 'roomInstallation', 'outerBuildingInstallation', 'interiorBuildingInstallation',
  'outerBridgeConstruction', 'outerBridgeInstallation', 'interiorBridgeInstallation', 'interiorBridgeRoom', 'bridgeRoomInstallation',
  'outerTunnelInstallation', 'interiorTunnelInstallation', 'interiorHollowSpace', 'hollowSpaceInstallation',
  'trafficArea', 'auxiliaryTrafficArea', 'groupMember',
]);
const shapeNode = node => isGml(node) && /^[A-Z_]/.test(node.localName) && !nonShapeNames.has(node.localName) && node.localName !== 'FeatureCollection' || isCity(node) && node.localName === 'ImplicitGeometry';
const geometryLodName = /^lod\d(?:Solid|MultiSolid|MultiSurface|Surface|MultiCurve|Curve|MultiPoint|Point|Geometry|ImplicitRepresentation|TerrainIntersection|FootPrint|RoofEdge|Network)$/;
const containsShape = node => shapeNode(node) || children(node).some(containsShape);
const collections = {
  MultiPoint: ['pointMember', 'pointMembers', new Set(['Point'])],
  MultiCurve: ['curveMember', 'curveMembers', new Set(['LineString', 'Curve', 'CompositeCurve', 'OrientableCurve'])],
  MultiLineString: ['lineStringMember', 'lineStringMembers', new Set(['LineString'])],
  MultiSurface: ['surfaceMember', 'surfaceMembers', new Set(['Polygon', 'Surface', 'CompositeSurface', 'OrientableSurface', 'TriangulatedSurface', 'Tin'])],
  CompositeSurface: ['surfaceMember', null, new Set(['Polygon', 'Surface', 'CompositeSurface', 'OrientableSurface', 'TriangulatedSurface', 'Tin'])],
  Shell: ['surfaceMember', null, new Set(['Polygon', 'Surface', 'CompositeSurface', 'OrientableSurface'])],
  MultiSolid: ['solidMember', 'solidMembers', new Set(['Solid', 'CompositeSolid'])],
  CompositeSolid: ['solidMember', null, new Set(['Solid', 'CompositeSolid'])],
  MultiGeometry: ['geometryMember', 'geometryMembers', null],
  GeometricComplex: ['element', null, null],
};
const envelopeCache = new WeakMap(); // Parsed DOM is immutable; cache local structure, not inherited CRS or placement values.

function firstGmlChild(node, name) {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && isGml(child, name)) return child;
  }
  return null;
}

function inheritedAttribute(element, names) {
  for (let node = element; node?.nodeType === 1; node = node.parentNode) {
    for (const name of names) if (node.hasAttribute(name)) return node.getAttribute(name);
    if (!envelopeCache.has(node)) {
      const boundedBy = firstGmlChild(node, 'boundedBy');
      envelopeCache.set(node, boundedBy ? firstGmlChild(boundedBy, 'Envelope') : null);
    }
    const envelope = envelopeCache.get(node);
    for (const name of names) if (envelope?.hasAttribute(name)) return envelope.getAttribute(name);
  }
  return undefined;
}

function numbers(element) {
  const words = element.textContent.trim().split(/\s+/);
  if (words.some(word => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(word))) {
    throw new Error('GML coordinates are empty, non-finite or invalid numbers.');
  }
  const values = words.map(Number);
  if (!values.every(Number.isFinite)) throw new Error('GML coordinates contain non-finite values.');
  return values;
}

function validateLine(points, ring = false) {
  if (points.length < (ring ? 4 : 2) || points.some(point => point.length !== 3 || !point.every(Number.isFinite))) {
    throw new Error(`${ring ? 'Ring' : 'LineString'} has invalid vertices or coordinates.`);
  }
  if (ring && !samePoint(points[0], points.at(-1))) throw new Error('Ring is not closed.');
  if (new Set(points.map(point => point.join(','))).size < (ring ? 3 : 2)) throw new Error('Not enough distinct vertices.');
  return points;
}

function joinCurves(primitives, ring = false) {
  const points = [];
  for (const primitive of primitives) {
    if (primitive.kind !== 'line') throw new Error('curveMember requires a line.');
    if (points.length && !samePoint(points.at(-1), primitive.points[0])) throw new Error('CompositeCurve / Ring curves are not contiguous.');
    for (const point of primitive.points.slice(points.length ? 1 : 0)) points.push(point);
  }
  return [{ kind: ring ? 'ring' : 'line', points: validateLine(points, ring) }];
}

function* vertices(primitive) {
  if (primitive.positions) {
    for (let i = 0; i < primitive.positions.length; i += 3) yield primitive.positions.subarray(i, i + 3);
  } else yield* primitive.points;
}

function renderPrimitives(primitives, { crs, has2D, lod, theme }) {
  const absoluteBounds = new THREE.Box3();
  let segments = 0, pointCount = 0;
  const batches = new Map();
  for (const primitive of primitives) {
    for (const point of vertices(primitive)) {
      if (point.length !== 3 || !point.every(Number.isFinite)) throw new Error('GML coordinates contain non-finite values.');
      absoluteBounds.expandByPoint(new THREE.Vector3(...point));
    }
    const isPoint = primitive.kind === 'point';
    const count = isPoint ? primitive.positions ? primitive.positions.length / 3 : primitive.points.length : primitive.points.length - 1;
    if (isPoint) pointCount += count;
    else segments += count;
    const key = `${isPoint ? 'point' : 'line'}:${primitive.surface}:${Boolean(primitive.colors)}`;
    if (!batches.has(key)) batches.set(key, { isPoint, surface: primitive.surface, rgb: Boolean(primitive.colors), count: 0, primitives: [] });
    const batch = batches.get(key);
    batch.count += count;
    batch.primitives.push(primitive);
  }
  if (absoluteBounds.isEmpty()) throw new Error('No visible GML geometry at the selected LOD.');
  const center = absoluteBounds.getCenter(new THREE.Vector3());
  const group = new THREE.Group(), bounds = new THREE.Box3();
  const resources = [], colorOf = palette(theme);
  for (const { isPoint, surface, rgb, count, primitives: batch } of [...batches.values()].sort((a, b) => a.isPoint - b.isPoint)) {
    const positions = new Float32Array(count * (isPoint ? 3 : 6));
    const colors = rgb ? new Uint8Array(count * 3) : null;
    let offset = 0, colorOffset = 0;
    for (const primitive of batch) {
      if (isPoint) {
        for (const point of vertices(primitive)) {
          for (let axis = 0; axis < 3; axis++) positions[offset++] = point[axis] - center.getComponent(axis);
        }
        if (colors) { colors.set(primitive.colors, colorOffset); colorOffset += primitive.colors.length; }
      } else {
        for (let i = 1; i < primitive.points.length; i++) {
          for (const point of [primitive.points[i - 1], primitive.points[i]]) {
            for (let axis = 0; axis < 3; axis++) positions[offset++] = point[axis] - center.getComponent(axis);
          }
        }
      }
    }
    if (!positions.every(Number.isFinite)) throw new Error('GML coordinates exceed the renderable numeric range.');
    const geometry = isPoint ? new THREE.BufferGeometry() : new LineSegmentsGeometry();
    if (isPoint) geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    else geometry.setPositions(positions);
    if (colors) geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox);
    const material = isPoint
      ? new THREE.PointsMaterial({ color: rgb ? 0xffffff : colorOf(surface), size: 2, sizeAttenuation: false, vertexColors: rgb })
      : new LineMaterial({ color: colorOf(surface), linewidth: .22, alphaToCoverage: true });
    const object = isPoint ? new THREE.Points(geometry, material) : new LineSegments2(geometry, material);
    object.userData.surface = surface;
    group.add(object);
    resources.push(geometry, material);
  }
  const rings = primitives.filter(primitive => primitive.kind === 'ring').length;
  const openLines = primitives.filter(primitive => primitive.kind === 'line').length;
  const dependencies = [...new Set(primitives.map(primitive => primitive.description).filter(Boolean))];
  const description = `GML original rings ${rings} / open lines ${openLines} / segments ${segments} / points ${pointCount} · LOD ${lod === 'highest' ? 'highest per feature' : lod === 'all' ? 'all (overlap)' : lod}${crs.size ? ` · ${[...crs].join(', ')}` : ''}${has2D ? ' · 2D display plane height=0 (no elevation)' : ''}${dependencies.length ? ` · ${dependencies.join(' / ')}` : ''}`;
  const screen = new THREE.Vector2(), centerPoint = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, .5);
  return {
    group, bounds, description,
    update(camera, renderer) {
      const height = renderer.getSize(screen).y;
      const coverage = camera.isPerspectiveCamera
        ? radius * height * camera.zoom / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.distanceTo(centerPoint))
        : radius * height * camera.zoom / (camera.top - camera.bottom);
      const width = THREE.MathUtils.clamp(coverage / 1400, .22, .85);
      group.children.forEach(child => { if (child.isLineSegments2) child.material.linewidth = width; });
    },
    dispose() { resources.forEach(resource => resource.dispose()); group.clear(); },
    setTheme(value) {
      const color = palette(value);
      group.children.forEach(child => { if (!child.geometry.hasAttribute('color')) child.material.color.set(color(child.userData.surface)); });
    },
  };
}

// All documents and primitives share one projection and one final center; templates never enter the root traversal.
export async function parseGml(text, { url, source, signal, lod = 'highest', theme = 'dark' } = {}) {
  signal?.throwIfAborted();
  if (typeof DOMParser === 'undefined') throw new Error('GML loading requires DOMParser.');
  if (!source || !url) throw new Error('parseGml requires a selected File source and URL.');
  if (!['highest', 'all', 0, 1, 2, 3, 4].includes(lod)) throw new Error('LOD must be highest / all / 0–4.');
  const rootUrl = source.resolve(url);
  const documents = new Map(), documentUrls = new WeakMap(), references = new Map(), crs = new Set();
  const entries = [];
  let project, has2D = false;
  function parseDocument(xml, documentUrl) {
    if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) throw new Error('GML with DTD / ENTITY is unsupported.');
    const document = new DOMParser({ onError: (_level, message) => { throw new Error(`Invalid GML XML syntax: ${message}`); } }).parseFromString(xml, 'application/xml');
    if (!document.documentElement || document.getElementsByTagNameNS('*', 'parsererror').length) throw new Error('Invalid GML XML syntax.');
    const ids = new Map();
    documentUrls.set(document, documentUrl);
    for (const node of Array.from(document.getElementsByTagName('*'))) {
      const id = idOf(node);
      if (id) {
        if (ids.has(id)) throw new Error(`Duplicate GML ID: ${id}`);
        ids.set(id, node);
      }
    }
    return { document, ids };
  }
  documents.set(rootUrl, Promise.resolve(parseDocument(text, rootUrl)));
  function referenceUrl(node, value) {
    let base = documentUrls.get(node.ownerDocument);
    const ancestors = [];
    for (let parent = node; parent?.nodeType === 1; parent = parent.parentNode) ancestors.push(parent);
    for (const parent of ancestors.reverse()) {
      if (parent.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base')) {
        base = source.resolve(parent.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'base'), base);
      }
    }
    const target = new URL(value, base);
    source.resolve(value, base); // Check each relative step before URL normalization can hide an escape.
    return target;
  }
  async function resolve(node, href, requireId = true) {
    const target = referenceUrl(node, href);
    const id = decodeURIComponent(target.hash.slice(1));
    target.hash = '';
    const documentUrl = target.href;
    if (requireId && !id) throw new Error(`xlink:href has no reference ID: ${href}`);
    if (!documents.has(documentUrl)) {
      documents.set(documentUrl, (async () => {
        const response = await source.fetch(documentUrl, { signal });
        const xml = await response.text();
        signal?.throwIfAborted();
        return parseDocument(xml, documentUrl);
      })());
    }
    const record = await documents.get(documentUrl);
    const element = id ? record.ids.get(id) : record.document.documentElement;
    if (!element) throw new Error(`GML reference ID not found: ${documentUrl}#${id}`);
    return element;
  }
  function projected(geographic) {
    if (!project) project = localProjector(geographic);
    return project(geographic);
  }
  function coordinateData(node, context) {
    const inherited = names => inheritedAttribute(node, names) ?? (context.properties ?? []).map(property => inheritedAttribute(property, names)).find(value => value !== undefined);
    const options = {
      srsName: inherited(['srsName']), dimension: inherited(['srsDimension', 'dimension']), axisLabels: inherited(['axisLabels']),
    };
    let reference;
    if (!context.relative) {
      const key = JSON.stringify(options);
      if (!references.has(key)) references.set(key, coordinateReference(options));
      reference = references.get(key);
      crs.add(`EPSG:${reference.code}`);
      has2D ||= !reference.hasElevation;
    }
    // The prototype is a local Cartesian system, not the enclosing feature's world CRS.
    let localDimension;
    if (context.relative) {
      for (let parent = node; parent?.nodeType === 1; parent = parent.parentNode) {
        localDimension = attribute(parent, 'srsDimension') ?? attribute(parent, 'dimension');
        if (localDimension !== undefined || parent === context.relativeRoot) break;
      }
    }
    const dimension = context.relative ? Number(localDimension ?? 3) : reference.dimension;
    if (![2, 3].includes(dimension)) throw new Error('Relative GML geometry requires dimension 2 or 3.');
    const values = numbers(node);
    if (values.length % dimension || isGml(node, 'pos') && values.length !== dimension) throw new Error('GML coordinate count does not match srsDimension.');
    const count = attribute(node, 'count');
    if (count !== undefined && (!/^\d+$/.test(count) || Number(count) !== values.length / dimension)) throw new Error('posList count does not match coordinate count.');
    const points = [];
    for (let i = 0; i < values.length; i += dimension) points.push(values.slice(i, i + dimension));
    return { points, reference };
  }
  async function positionSequence(node, context, active) {
    const nodes = children(node).filter(child => !isGml(child) || !metadataNames.has(child.localName));
    if (!nodes.length) throw new Error(`${node.localName} has no coordinates.`);
    const lists = nodes.filter(child => isGml(child, 'posList'));
    if (lists.length && (lists.length !== 1 || nodes.length !== 1)) throw new Error('posList cannot be mixed with other coordinate forms.');
    const result = [];
    for (const child of nodes) {
      if (isGml(child, 'pos') || isGml(child, 'posList')) {
        const { points, reference } = coordinateData(child, context);
        for (const point of points) result.push(context.relative ? [...point, ...Array(3 - point.length).fill(0)] : projected(reference.toGeographic(point)));
      } else if (isGml(child, 'pointProperty') || isGml(child, 'pointRep')) {
        const points = await property(child, context, active, new Set(['Point']));
        for (const primitive of points) for (const point of primitive.points) result.push(point);
      } else throw new Error(`Unsupported GML coordinate form: ${child.localName}`);
    }
    return result;
  }
  async function property(node, context, active, expected, multiple = false) {
    const href = hrefOf(node), inline = children(node);
    if (href !== undefined && inline.length) throw new Error(`${node.localName} has conflicting xlink and inline geometry.`);
    const nodes = href !== undefined ? [await resolve(node, href)] : inline;
    if (!nodes.length || !multiple && nodes.length !== 1) throw new Error(`${node.localName} has an invalid geometry count.`);
    const result = [];
    for (const child of nodes) {
      if (expected && !expected.has(child.localName)) throw new Error(`${node.localName} references invalid geometry: ${child.localName}`);
      const next = { ...context, properties: [node, ...(context.properties ?? [])], relativeRoot: context.relativeRoot ?? (context.relative ? child : undefined) };
      for (const primitive of await geometry(child, next, active)) result.push(primitive);
    }
    return result;
  }
  async function implicit(node, context, active) {
    if (context.relative) throw new Error('ImplicitGeometry inside relative geometry is unsupported.');
    const parts = children(node);
    const allowed = new Set(['mimeType', 'transformationMatrix', 'libraryObject', 'relativeGMLGeometry', 'referencePoint']);
    if (parts.some(child => !allowed.has(child.localName) && !metadataNames.has(child.localName))) throw new Error('ImplicitGeometry has an unknown element.');
    const anchors = parts.filter(child => child.localName === 'referencePoint');
    if (anchors.length !== 1) throw new Error('ImplicitGeometry requires one referencePoint.');
    const anchorProperty = anchors[0], anchorHref = hrefOf(anchorProperty), inlineAnchor = children(anchorProperty);
    if (anchorHref !== undefined && inlineAnchor.length) throw new Error('referencePoint has conflicting xlink and inline geometry.');
    const anchorNode = anchorHref === undefined ? inlineAnchor[0] : await resolve(anchorProperty, anchorHref);
    if (!anchorNode || !isGml(anchorNode, 'Point') || anchorHref === undefined && inlineAnchor.length !== 1) throw new Error('referencePoint requires a Point.');
    const anchorPositions = children(anchorNode).filter(child => !metadataNames.has(child.localName));
    if (anchorPositions.length !== 1 || !isGml(anchorPositions[0], 'pos')) throw new Error('referencePoint requires one pos.');
    const { points: anchorPoints, reference } = coordinateData(anchorPositions[0], { ...context, properties: [anchorProperty, ...(context.properties ?? [])] });
    const anchor = anchorPoints[0];
    const matrices = parts.filter(child => child.localName === 'transformationMatrix');
    if (matrices.length > 1) throw new Error('Duplicate transformationMatrix.');
    const matrix = matrices.length ? numbers(matrices[0]) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (matrix.length !== 16) throw new Error('transformationMatrix requires 16 row-major values.');
    const relative = parts.filter(child => child.localName === 'relativeGMLGeometry');
    const libraries = parts.filter(child => child.localName === 'libraryObject');
    if (relative.length + libraries.length !== 1) throw new Error('ImplicitGeometry requires one relativeGMLGeometry or libraryObject.');
    let primitives;
    if (relative.length) primitives = await property(relative[0], { ...context, relative: true }, active);
    else {
      const library = referenceUrl(libraries[0], libraries[0].textContent.trim());
      if (!/\.(gml|xml|citygml)$/i.test(library.pathname)) throw new Error('libraryObject supports only local GML geometry (OBJ / CAD are outside this profile).');
      const target = await resolve(libraries[0], library.href, false);
      primitives = await geometry(target, { ...context, relative: true, relativeRoot: target }, active);
    }
    for (const primitive of primitives) {
      primitive.points = primitive.points.map(point => {
        const homogeneous = [...point, 1];
        const transformed = [0, 1, 2, 3].map(row => homogeneous.reduce((sum, value, column) => sum + matrix[row * 4 + column] * value, 0));
        if (!transformed.every(Number.isFinite) || transformed[3] === 0) throw new Error('ImplicitGeometry transform is non-finite or has w=0.');
        const world = anchor.map((value, axis) => value + transformed[axis] / transformed[3]);
        const geographic = reference.toGeographic(world);
        // A 2D anchor is on the declared display plane; the prototype still supplies relative height.
        if (!reference.hasElevation) geographic[2] = transformed[2] / transformed[3];
        return projected(geographic);
      });
      primitive.placement = true;
    }
    return primitives;
  }
  async function geometry(node, context, active) {
    signal?.throwIfAborted();
    if (active.has(node)) throw new Error(`Cyclic GML reference: ${idOf(node) || node.localName}`);
    const path = new Set(active).add(node), name = node.localName;
    let primitives;
    if (isCity(node) && name === 'ImplicitGeometry') primitives = await implicit(node, context, path);
    else {
      if (!isGml(node)) throw new Error(`Unsupported GML geometry: ${name}`);
      const parts = children(node).filter(child => !isGml(child) || !metadataNames.has(child.localName));
      if (['Point', 'LineString', 'LineStringSegment', 'LinearRing'].includes(name)) {
        const points = await positionSequence(node, context, path);
        if (name === 'Point' && points.length !== 1) throw new Error('Point requires exactly one position.');
        if (name !== 'Point') validateLine(points, name === 'LinearRing');
        if (name === 'LineStringSegment' && attribute(node, 'interpolation') && attribute(node, 'interpolation') !== 'linear') throw new Error('LineStringSegment supports only linear interpolation.');
        primitives = [{ kind: name === 'Point' ? 'point' : name === 'LinearRing' ? 'ring' : 'line', points }];
      } else if (['CompositeCurve', 'Ring', 'Curve'].includes(name)) {
        const curves = [];
        if (name === 'Curve') {
          if (parts.length !== 1 || !isGml(parts[0], 'segments')) throw new Error('Curve requires segments.');
          for (const segment of children(parts[0])) {
            if (!isGml(segment, 'LineStringSegment')) throw new Error(`Unsupported GML curve: ${segment.localName}`);
            for (const primitive of await geometry(segment, context, path)) curves.push(primitive);
          }
        } else {
          for (const part of parts) {
            if (!isGml(part, 'curveMember')) throw new Error(`Unsupported ${name} element: ${part.localName}`);
            for (const primitive of await property(part, context, path, new Set(['LineString', 'Curve', 'CompositeCurve', 'OrientableCurve']))) curves.push(primitive);
          }
        }
        primitives = joinCurves(curves, name === 'Ring');
      } else if (['OrientableCurve', 'OrientableSurface'].includes(name)) {
        const base = name === 'OrientableCurve' ? 'baseCurve' : 'baseSurface';
        if (parts.length !== 1 || !isGml(parts[0], base)) throw new Error(`${name} requires ${base}.`);
        const orientation = attribute(node, 'orientation') ?? '+';
        if (!['+', '-'].includes(orientation)) throw new Error('orientation must be + or -.');
        primitives = await property(parts[0], context, path, new Set(name === 'OrientableCurve' ? ['LineString', 'Curve', 'CompositeCurve', 'OrientableCurve'] : ['Polygon', 'Surface', 'CompositeSurface', 'OrientableSurface', 'TriangulatedSurface', 'Tin']));
        if (orientation === '-') primitives.forEach(primitive => primitive.points.reverse());
      } else if (['Polygon', 'PolygonPatch', 'Triangle', 'Solid'].includes(name)) {
        const exterior = parts.filter(child => isGml(child, 'exterior'));
        if (exterior.length !== 1 || parts.some(child => !isGml(child, 'exterior') && !isGml(child, 'interior'))) throw new Error(`Invalid ${name} exterior / interior.`);
        primitives = [];
        const expected = new Set(name === 'Solid' ? ['CompositeSurface', 'Shell', 'Surface', 'Polygon', 'OrientableSurface'] : ['LinearRing', 'Ring']);
        for (const part of parts) for (const primitive of await property(part, context, path, expected)) primitives.push(primitive);
        if (name === 'Triangle' && (parts.length !== 1 || primitives.length !== 1 || primitives[0].points.length !== 4)) throw new Error('Triangle requires a closed three-vertex exterior ring.');
      } else if (['Surface', 'TriangulatedSurface', 'Tin'].includes(name)) {
        const patchName = name === 'Surface' ? 'patches' : 'trianglePatches';
        const patches = parts.filter(child => isGml(child, patchName));
        if (patches.length > 1) throw new Error(`Duplicate ${patchName}.`);
        primitives = patches.length && (children(patches[0]).length || hrefOf(patches[0]) !== undefined) ? await property(patches[0], context, path, new Set(name === 'Surface' ? ['PolygonPatch', 'Triangle'] : ['Triangle']), true) : [];
        if (name === 'Tin') {
          const controls = parts.filter(child => isGml(child, 'controlPoint'));
          const lengths = parts.filter(child => isGml(child, 'maxLength'));
          if (controls.length > 1 || lengths.length > 1 || parts.some(child => !isGml(child) || !['trianglePatches', 'controlPoint', 'maxLength', 'stopLines', 'breakLines'].includes(child.localName))) throw new Error('Invalid Tin elements.');
          const breakLines = [], stopLines = [];
          for (const part of parts.filter(child => ['stopLines', 'breakLines'].includes(child.localName))) {
            for (const segment of children(part)) {
              if (!isGml(segment, 'LineStringSegment')) throw new Error(`Unsupported TIN constraint: ${segment.localName}`);
              (part.localName === 'stopLines' ? stopLines : breakLines).push((await geometry(segment, context, path))[0].points);
            }
          }
          if (controls.length) {
            if (lengths.length !== 1) throw new Error('Control-point Tin requires maxLength.');
            const length = numbers(lengths[0]);
            const unit = attribute(lengths[0], 'uom');
            const scale = { m: 1, metre: 1, meter: 1, km: 1000, cm: .01, mm: .001, 'urn:ogc:def:uom:OGC::m': 1,
              'urn:ogc:def:uom:OGC::metre': 1, 'urn:ogc:def:uom:EPSG::9001': 1, 'http://www.opengis.net/def/uom/EPSG/0/9001': 1 }[unit];
            if (length.length !== 1 || length[0] <= 0 || !scale) throw new Error(`Invalid or unsupported Tin maxLength / unit: ${unit}`);
            const controlPoints = await positionSequence(controls[0], context, path);
            if (controlPoints.length < 3) throw new Error('Tin requires at least three controlPoint values.');
            if (!primitives.length) {
              const toYUp = point => context.relative ? [point[0], point[2], point[1]] : point;
              primitives = triangulateTin(controlPoints.map(toYUp), breakLines.map(line => line.map(toYUp)), stopLines.map(line => line.map(toYUp)), length[0] * scale);
              if (context.relative) primitives.forEach(primitive => { primitive.points = primitive.points.map(toYUp); });
            }
          } else if (!primitives.length || breakLines.length || stopLines.length || lengths.length) throw new Error('Tin requires controlPoint or trianglePatches.');
        } else if (parts.length !== 1 || !patches.length) throw new Error(`${name} requires ${patchName}.`);
        if (!primitives.length) throw new Error(`${name} has no visible triangles or surfaces.`);
      } else {
        const collection = collections[name];
        if (!collection) throw new Error(`Unsupported GML geometry: ${name}`);
        primitives = [];
        for (const part of parts) {
          if (!isGml(part) || ![collection[0], collection[1]].includes(part.localName)) throw new Error(`Unsupported ${name} element: ${part.localName}`);
          for (const primitive of await property(part, context, path, collection[2], part.localName === collection[1])) primitives.push(primitive);
        }
        if (!primitives.length) throw new Error(`${name} is empty.`);
      }
    }
    return ['LinearRing', 'Ring'].includes(name) ? primitives.map(primitive => ({ ...primitive, ring: node })) : primitives;
  }
  async function pointCloud(node, context, active) {
    const parts = children(node), primitives = [];
    if (parts.some(child => !(isUro(child) && child.localName === 'points') && containsShape(child))) throw new Error('PointCloud geometry must be MultiPoint in uro:points.');
    for (const points of parts.filter(child => isUro(child) && child.localName === 'points')) {
      for (const primitive of await property(points, context, active, new Set(['MultiPoint']))) primitives.push(primitive);
    }
    const srsNames = parts.filter(child => isUro(child) && child.localName === 'pointFileSrsName');
    if (srsNames.length > 1) throw new Error('Duplicate pointFileSrsName.');
    for (const file of parts.filter(child => isUro(child) && child.localName === 'pointFile')) {
      const target = referenceUrl(file, file.textContent.trim());
      if (!/\.(las|laz)$/i.test(target.pathname)) throw new Error('pointFile must be a local LAS / LAZ file.');
      target.hash = '';
      const fileUrl = target.href;
      const { readPointCloud } = await import('./point-cloud.js');
      const cloud = await readPointCloud(fileUrl, { source, signal, srsName: srsNames[0]?.textContent.trim() });
      if (!(cloud.positions instanceof Float64Array) || cloud.positions.length !== cloud.count * 3 || !cloud.count || cloud.colors && cloud.colors.length !== cloud.positions.length) throw new Error('Dependent point cloud position / color counts are invalid.');
      const positions = new Float64Array(cloud.positions.length);
      for (let i = 0; i < positions.length; i += 3) positions.set(projected(Array.from(cloud.positions.subarray(i, i + 3))), i);
      primitives.push({ kind: 'point', positions, colors: cloud.colors, description: cloud.description });
    }
    if (!primitives.length) throw new Error('PointCloud has no points / pointFile.');
    return primitives;
  }
  async function walk(node, owner, currentLod, active, properties = [], inheritedSurface = 'Unclassified') {
    signal?.throwIfAborted();
    if (active.has(node)) throw new Error(`Cyclic GML reference: ${idOf(node) || node.localName}`);
    if (isGml(node) && (metadataNames.has(node.localName) || nonShapeNames.has(node.localName)) || nonDrawingProperties.has(node.localName)) return;
    const path = new Set(active).add(node);
    const surface = semanticType(node) ?? inheritedSurface;
    const lodProperty = geometryLodName.test(node.localName) || hrefOf(node) !== undefined || children(node).some(shapeNode);
    const lodMatch = lodProperty && (isCity(node) || isUro(node)) && node.localName.match(/^lod([0-4])(?:[A-Z_]|$)/);
    if (lodMatch) currentLod = Number(lodMatch[1]);
    if (lodProperty && (isCity(node) || isUro(node)) && /^lod\d/.test(node.localName) && !lodMatch) throw new Error(`Unsupported LOD property: ${node.localName}`);
    const declaredLods = children(node).filter(child => (isCity(child) || isUro(child)) && child.localName === 'lod');
    if (declaredLods.length) {
      if (declaredLods.length !== 1 || !/^[0-4]$/.test(declaredLods[0].textContent.trim())) throw new Error('Feature lod must be one value from 0–4.');
      currentLod = Number(declaredLods[0].textContent.trim());
    }
    const context = { properties };
    if (shapeNode(node) || isUro(node) && node.localName === 'PointCloud') {
      const primitives = shapeNode(node) ? await geometry(node, context, active) : await pointCloud(node, context, path);
      entries.push({ owner, lod: currentLod, primitives: primitives.map(primitive => ({ ...primitive, surface })) });
      return;
    }
    const href = hrefOf(node);
    if (href !== undefined) {
      if (children(node).length) throw new Error(`${node.localName} has conflicting xlink and inline elements.`);
      const target = await resolve(node, href);
      // LOD and feature membership come from the referring property, not the dictionary declaration.
      const nextOwner = ownerProperties.has(node.localName) ? node : owner;
      await walk(target, nextOwner, nextOwner === node ? undefined : currentLod, path, [node, ...properties], surface);
      return;
    }
    if (lodMatch && !children(node).length) throw new Error(`${node.localName} has no geometry.`);
    for (const child of children(node)) {
      const resetOwner = ownerProperties.has(node.localName) || !owner && (isCity(child) || isUro(child)) && /^[A-Z]/.test(child.localName) && child.localName !== 'CityModel';
      const nextOwner = resetOwner ? child : owner;
      await walk(child, nextOwner, resetOwner ? undefined : currentLod, path, properties, surface);
    }
  }
  const root = (await documents.get(rootUrl)).document.documentElement;
  await walk(root, root, undefined, new Set());
  const highest = new Map();
  entries.forEach(entry => { if (entry.lod !== undefined) highest.set(entry.owner, Math.max(highest.get(entry.owner) ?? -1, entry.lod)); });
  const selected = entries.filter(entry => entry.lod === undefined || lod === 'all' || entry.lod === (lod === 'highest' ? highest.get(entry.owner) : lod));
  // Solids can reference classified rings. Keep the classified copy and draw each source ring once per LOD and surface type.
  const semanticFaces = new Map();
  for (const entry of selected) for (const primitive of entry.primitives) {
    if (!primitive.ring || primitive.placement || primitive.surface === 'Unclassified') continue;
    if (!semanticFaces.has(entry.lod)) semanticFaces.set(entry.lod, new Set());
    semanticFaces.get(entry.lod).add(primitive.ring);
  }
  const seen = new Map(), unique = [];
  for (const entry of selected) for (const primitive of entry.primitives) {
    if (primitive.surface === 'Unclassified' && !primitive.placement && semanticFaces.get(entry.lod)?.has(primitive.ring)) continue;
    if (primitive.ring && !primitive.placement) {
      const key = `${entry.lod}:${primitive.surface}`;
      if (!seen.has(key)) seen.set(key, new Set());
      if (seen.get(key).has(primitive.ring)) continue;
      seen.get(key).add(primitive.ring);
    }
    unique.push(primitive);
  }
  signal?.throwIfAborted();
  return renderPrimitives(unique, { crs, has2D, lod, theme });
}

export async function loadGml(url, options = {}) {
  options.signal?.throwIfAborted();
  const source = options.source;
  if (!source) throw new Error('Choose a local GML file.');
  const rootUrl = source.resolve(url);
  const response = await source.fetch(rootUrl, { signal: options.signal });
  const text = await response.text();
  options.signal?.throwIfAborted();
  return parseGml(text, { ...options, url: rootUrl });
}
