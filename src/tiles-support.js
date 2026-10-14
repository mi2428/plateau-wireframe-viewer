import { Group, Matrix4, Vector3 } from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { CMPTLoaderBase, I3DMLoaderBase, LoaderUtils } from '3d-tiles-renderer/core';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { ImplicitTilingPlugin } from '3d-tiles-renderer/core/plugins';
import { SUBTREELoader } from '3d-tiles-renderer/src/core/plugins/SUBTREELoader.js';

const tilesExtensions = new Set(['3DTILES_content_gltf', '3DTILES_implicit_tiling', '3DTILES_multiple_contents', '3DTILES_draco_point_compression']);

// Internal data URIs are allowed; every other content URI stays within the selected File scope.
export function tileResourceUrl(value, base, source) {
  const url = new URL(value, base);
  if (url.protocol === 'data:') {
    if (!/^data:[^,]*,/.test(url.href)) throw new Error('Invalid content data URI.');
    return url.href;
  }
  return source.resolve(value, base);
}

class LocalI3DMLoaderBase extends I3DMLoaderBase {
  resolveExternalURL(value) {
    this.externalVirtual = tileResourceUrl(value.trimEnd(), this.workingPath, this.source);
    this.externalUrl = this.externalVirtual.startsWith('data:') ? this.externalVirtual : this.source.objectUrl(this.externalVirtual);
    return this.externalUrl;
  }
}

function oct32(array, index, target) {
  const x = array[index * 2] / 65535 * 2 - 1, y = array[index * 2 + 1] / 65535 * 2 - 1;
  target.set(x, y, 1 - Math.abs(x) - Math.abs(y));
  if (target.z < 0) target.set((1 - Math.abs(y)) * (x < 0 ? -1 : 1), (1 - Math.abs(x)) * (y < 0 ? -1 : 1), target.z);
  return target.normalize();
}

function contentBase(url, tile) {
  return url.startsWith('data:') ? `${tile.internal.basePath}/` : url;
}

function contentJson(buffer) {
  const bytes = new Uint8Array(buffer);
  let index = 0;
  while ([9, 10, 13, 32].includes(bytes[index])) index++;
  return bytes[index] === 123 ? JSON.parse(new TextDecoder().decode(buffer)) : null;
}

function removeChildren(tiles, tile) {
  const descendants = [];
  const visit = child => { for (const next of child.children || []) visit(next); descendants.push(child); };
  for (const child of tile.children) visit(child);
  for (const child of descendants) {
    tiles.processNodeQueue.remove(child);
    tiles.lruCache.remove(child);
    tiles.processedTiles.delete(child);
  }
  tile.children.length = 0;
}

function markRenderable(tile) {
  if (!tile.internal.hasRenderableContent) {
    tile.internal.depthFromRenderedParent++;
    // An empty JSON locator may already be visible before its type is known.
    // Its newly decoded scene still needs a real setTileVisible transition.
    Object.assign(tile.traversal, { visible: false, wasSetVisible: false, active: false, wasSetActive: false });
  }
  tile.internal.hasRenderableContent = true;
  tile.internal.hasUnrenderableContent = false;
}

function requiredExtensions(json, supported) {
  for (const name of json.extensionsRequired || []) {
    if (!supported.has(name)) throw new Error(`Unsupported required extension: ${name}`);
  }
}

export function validateGltf(parser) {
  if (parser.json.asset?.version !== '2.0' || (parser.json.asset.minVersion && parser.json.asset.minVersion !== '2.0')) {
    throw new Error('Only glTF version 2.0 is supported.');
  }
  requiredExtensions(parser.json, new Set([...Object.keys(parser.extensions), ...Object.keys(parser.plugins)]));
}

export class LocalTilesRenderer extends TilesRenderer {
  constructor(url, source) { super(url); this.source = source; }
  preprocessTileset(json, url, parent) {
    if (!['1.0', '1.1'].includes(json.asset?.version)) throw new Error('Only 3D Tiles version 1.0 / 1.1 is supported.');
    requiredExtensions(json, tilesExtensions);
    const ancestors = parent?.externalAncestors || [];
    if (ancestors.includes(url)) throw new Error('Cyclic external tileset reference.');
    const base = url.startsWith('data:') ? `${parent.internal.basePath}/` : url;
    json.root.externalAncestors = [...ancestors, url];
    if (!parent) {
      const up = (json.asset.gltfUpAxis || 'Y').toUpperCase();
      if (!['X', 'Y', 'Z'].includes(up)) throw new Error('Invalid gltfUpAxis.');
      this.gltfUpTransform = up === 'X' ? new Matrix4().makeRotationY(-Math.PI / 2)
        : up === 'Y' ? new Matrix4().makeRotationX(Math.PI / 2) : new Matrix4();
    }
    // Validate before handing the root to the renderer, including not-yet-selected children.
    const visit = tile => {
      const implicit = tile.implicitTiling || tile.extensions?.['3DTILES_implicit_tiling'];
      const contents = tile.contents || tile.extensions?.['3DTILES_multiple_contents']?.contents;
      if (contents && (tile.content || !Array.isArray(contents) || !contents.length)) throw new Error('Invalid content / contents declaration.');
      for (const content of contents || (tile.content ? [tile.content] : [])) {
        const uri = content.uri ?? content.url;
        if (typeof uri !== 'string' || !uri.length) throw new Error('Missing content.uri.');
        tileResourceUrl(uri, base, this.source);
        content.uri = uri;
      }
      if (implicit) {
        tileResourceUrl(implicit.subtrees.uri, base, this.source);
        if (!['QUADTREE', 'OCTREE'].includes(implicit.subdivisionScheme) ||
            !Number.isInteger(implicit.subtreeLevels) || implicit.subtreeLevels < 1 ||
            !Number.isInteger(implicit.availableLevels) || implicit.availableLevels < 1 ||
            (!tile.boundingVolume.box && !tile.boundingVolume.region) || tile.children?.length) {
          throw new Error('Invalid implicitTiling scheme / levels / boundingVolume / children.');
        }
        tile.implicitTiling = implicit;
      }
      if (contents) tile.contents = contents;
      for (const child of tile.children || []) visit(child);
    };
    visit(json.root);
    // The upstream method derives a directory from a URL, which a data URI lacks.
    // Node preprocessing itself still performs all engine transform/LOD setup.
    const directory = LoaderUtils.getWorkingPath(base).replace(/\/+$/, '');
    this.preprocessNode(json.root, directory, parent);
  }

  preprocessNode(tile, directory, parent) {
    tile.externalAncestors ??= parent?.externalAncestors;
    tile.externalContentOwner ??= parent?.externalContentOwner;
    if (tile.implicitTiling) {
      tile.implicitContents = tile.contents || (tile.content ? [tile.content] : []);
      // The implicit root is a subtree locator, never a renderable first content.
      tile.content = { uri: tile.implicitTiling.subtrees.uri };
      delete tile.contents;
    } else if (tile.contents) {
      // One scheduler/cache/LOD entry owns every content; the plugin parses all of them.
      tile.content = { uri: tile.contents[0].uri };
    }
    super.preprocessNode(tile, directory, parent);
  }

  calculateTileViewError(tile, target) {
    super.calculateTileViewError(tile, target);
    target.error *= tile.engineData.transform.getMaxScaleOnAxis();
  }

  async parseTile(buffer, tile, extension, url, signal) {
    try {
      await super.parseTile(buffer, tile, extension, url, signal);
      if (tile.engineData.scene) markRenderable(tile);
    }
    finally {
      if (signal.aborted) this.dispatchEvent({ type: 'discard-model', tile });
    }
  }
}

class LocalSubtreeLoader extends SUBTREELoader {
  constructor(tile, tiles, signal) {
    super(tile);
    this.tiles = tiles;
    this.signal = signal;
  }

  parseBuffer(buffer) {
    let result;
    if (!(buffer instanceof ArrayBuffer)) {
      result = { version: 1, subtreeJson: buffer, subtreeByte: new ArrayBuffer(0) };
    } else if (LoaderUtils.readMagicBytes(buffer) === 'subt') {
      const view = new DataView(buffer);
      if (view.getUint32(4, true) !== 1 || 24n + view.getBigUint64(8, true) + view.getBigUint64(16, true) !== BigInt(buffer.byteLength)) {
        throw new Error('Invalid subtree version / byteLength.');
      }
      result = super.parseBuffer(buffer);
    } else {
      result = { version: 1, subtreeJson: JSON.parse(new TextDecoder().decode(buffer)), subtreeByte: new ArrayBuffer(0) };
    }
    result.subtreeJson.contentAvailability ??= [];
    requiredExtensions(result.subtreeJson, new Set());
    return result;
  }

  async requestActiveBuffers(headers, internalBuffer) {
    const subtreeUrl = this.parseImplicitURI(this.tile, this.rootTile.implicitTiling.subtrees.uri);
    const base = subtreeUrl.startsWith('data:') ? `${this.workingPath}/` : new URL(subtreeUrl, `${this.workingPath}/`);
    const buffers = await Promise.all(headers.map(async header => {
      if (!header.isActive) return undefined;
      if (!header.isExternal) return new Uint8Array(internalBuffer);
      const url = tileResourceUrl(header.uri, base, this.tiles.source);
      const response = await this.tiles.fetchResource(url, { ...this.fetchOptions, signal: this.signal });
      if (!response.ok) throw new Error(`Subtree buffer load failed: ${url} (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < header.byteLength) throw new Error('Invalid subtree buffer byteLength.');
      return bytes;
    }));
    return Object.fromEntries(buffers.map((value, index) => [index, value]).filter(([, value]) => value));
  }

  preprocessBufferViews(views = [], headers) {
    for (const view of views) view.byteOffset ??= 0;
    return super.preprocessBufferViews(views, headers);
  }

  assignContents(tile, subtree, index) {
    delete tile.content;
    const templates = this.rootTile.implicitContents;
    if (subtree._contentAvailabilityBitstreams.length !== templates.length) throw new Error('Subtree contentAvailability does not match contents count.');
    const contents = templates.flatMap((content, i) => this.getBit(subtree._contentAvailabilityBitstreams[i], index)
      ? [{ uri: this.parseImplicitURI(tile, content.uri) }] : []);
    if (contents.length) tile.contents = contents;
  }

  parseAvailabilityBitstream(json, buffers, length) {
    if (json.constant !== undefined && ![0, 1].includes(json.constant)) throw new Error('Invalid subtree availability.constant.');
    const stream = super.parseAvailabilityBitstream(json, buffers, length);
    if (stream.constant === undefined && (!stream.bitstream || stream.bitstream.byteLength < Math.ceil(length / 8))) {
      throw new Error('Subtree availability bitstream is too short.');
    }
    return stream;
  }

  expandSubtree(root, subtree) {
    this.signal.throwIfAborted();
    if (!this.getBit(subtree._tileAvailability, 0)) throw new Error('Subtree root is unavailable.');
    const offset = root.children.length;
    super.expandSubtree(root, subtree);
    this.assignContents(root.children[offset], subtree, 0);
  }

  deriveChildTile(subtree, parent, index, morton) {
    const tile = super.deriveChildTile(subtree, parent, index, morton);
    if (tile.implicitTilingData.level >= this.rootTile.implicitTiling.availableLevels) throw new Error('Implicit tile exceeds availableLevels.');
    if (subtree) this.assignContents(tile, subtree, index);
    else tile.implicitSubtree = true;
    return tile;
  }
}

export class LocalImplicitTilingPlugin extends ImplicitTilingPlugin {
  preprocessNode(tile, directory, parent) {
    super.preprocessNode(tile, directory, parent);
    if (tile.implicitSubtree) {
      tile.internal.hasRenderableContent = false;
      tile.internal.hasUnrenderableContent = true;
    }
  }

  parseTile(buffer, tile, extension, url, signal) {
    if (!tile.implicitTiling && !tile.implicitSubtree) return null;
    const loader = new LocalSubtreeLoader(tile, this.tiles, signal);
    loader.workingPath = tile.internal.basePath;
    loader.fetchOptions = this.tiles.fetchOptions;
    return loader.parse(buffer);
  }

  disposeTile(tile) {
    if (!tile.implicitTiling && !tile.implicitSubtree) return;
    removeChildren(this.tiles, tile);
  }
}

function validateBinary(buffer) {
  const magic = LoaderUtils.readMagicBytes(buffer);
  if (['b3dm', 'i3dm', 'pnts', 'cmpt'].includes(magic)) {
    const view = new DataView(buffer);
    if (view.getUint32(4, true) !== 1 || view.getUint32(8, true) !== buffer.byteLength) throw new Error(`Invalid ${magic} version / byteLength.`);
  }
  return magic;
}

export class TileContentsPlugin {
  constructor() { this.name = 'ALL_TILE_CONTENTS'; }
  init(tiles) { this.tiles = tiles; }

  parseTile(buffer, tile, extension, url, signal) {
    if (tile.implicitTiling || tile.implicitSubtree) return null;
    if (tile.contents) {
      return this.parseGroup(tile.contents.map((content, index) => ({
         url: tileResourceUrl(content.uri, `${tile.internal.basePath}/`, this.tiles.source),
        buffer: index === 0 ? buffer : null,
      })), tile, signal);
    }
    const json = contentJson(buffer);
    if (json?.root) return this.expandContents([{ json, url }], tile, signal);
    if (json) {
      return this.tiles.parseTile(new TextEncoder().encode(JSON.stringify(json)).buffer, tile, 'gltf', contentBase(url, tile), signal);
    }
    const magic = validateBinary(buffer);
    if (magic === 'i3dm') return this.parseInstances(buffer, tile, signal, url);
    if (magic !== 'cmpt') {
      if (url.startsWith('data:')) return this.tiles.parseTile(buffer, tile, extension, contentBase(url, tile), signal);
      return null;
    }
    const { tiles } = new CMPTLoaderBase().parse(buffer);
    if (!tiles.length || tiles.reduce((length, child) => length + child.buffer.byteLength, 16) !== buffer.byteLength ||
        tiles.some(child => !['b3dm', 'i3dm', 'pnts', 'cmpt'].includes(child.type))) {
      throw new Error('Invalid cmpt child tile / byteLength.');
    }
    return this.parseGroup(tiles.map(child => ({ buffer: child.buffer.slice().buffer, url })), tile, signal);
  }

  async parseInstances(buffer, tile, signal, url) {
    const loader = new LocalI3DMLoaderBase();
    loader.source = this.tiles.source;
    loader.workingPath = LoaderUtils.getWorkingPath(contentBase(url, tile));
    loader.fetchOptions = { ...this.tiles.fetchOptions, signal: AbortSignal.any([this.tiles.fetchOptions.signal, signal]) };
    const result = await loader.parse(buffer);
    signal.throwIfAborted();
    const gltfLoader = this.tiles.manager.getHandler('path.gltf');
    const path = loader.externalVirtual && !loader.externalVirtual.startsWith('data:') ? LoaderUtils.getWorkingPath(loader.externalVirtual) : loader.workingPath;
    const model = await gltfLoader.parseAsync(result.glbBytes.slice().buffer, path);
    const features = result.featureTable;
    const count = features.getData('INSTANCES_LENGTH');
    if (!Number.isInteger(count) || count < 0) throw new Error('Invalid i3dm INSTANCES_LENGTH.');
    if (count === 0) {
      this.tiles.dispatchEvent({ type: 'consume-template', scene: model.scene, unused: true });
      return this.ownScene(new Group(), tile, signal);
    }
    const read = (name, component, type, length = count) => {
      const values = features.getData(name, length, component, type);
      if (values && values.length !== length * ({ SCALAR: 1, VEC2: 2, VEC3: 3 }[type])) throw new Error(`Invalid i3dm ${name} element count.`);
      return values;
    };
    const positions = read('POSITION', 'FLOAT', 'VEC3'), quantized = read('POSITION_QUANTIZED', 'UNSIGNED_SHORT', 'VEC3');
    const offset = read('QUANTIZED_VOLUME_OFFSET', 'FLOAT', 'VEC3', 1), volume = read('QUANTIZED_VOLUME_SCALE', 'FLOAT', 'VEC3', 1);
    const up = read('NORMAL_UP', 'FLOAT', 'VEC3'), right = read('NORMAL_RIGHT', 'FLOAT', 'VEC3');
    const upOct = read('NORMAL_UP_OCT32P', 'UNSIGNED_SHORT', 'VEC2'), rightOct = read('NORMAL_RIGHT_OCT32P', 'UNSIGNED_SHORT', 'VEC2');
    const scale = read('SCALE', 'FLOAT', 'SCALAR'), scale3 = read('SCALE_NON_UNIFORM', 'FLOAT', 'VEC3');
    const rtc = read('RTC_CENTER', 'FLOAT', 'VEC3', 1);
    const gltfRtc = model.parser.json.extensions?.CESIUM_RTC?.center;
    if ((!positions && !quantized) || (quantized && (!offset || !volume)) || Boolean(up) !== Boolean(right) || Boolean(upOct) !== Boolean(rightOct)) {
      throw new Error('Invalid i3dm position / orientation semantic dependencies.');
    }
    if (gltfRtc && gltfRtc.length !== 3) throw new Error('Invalid glTF CESIUM_RTC.center element count.');
    for (const array of [positions, offset, volume, up, right, scale, scale3, rtc, gltfRtc]) {
      if (array && !Array.from(array).every(Number.isFinite)) throw new Error('i3dm instance values are non-finite.');
    }
    const scene = new Group(), position = new Vector3(), scaling = new Vector3(), u = new Vector3(), r = new Vector3(), north = new Vector3();
    const quantOffset = offset && new Vector3().fromArray(offset), quantScale = volume && new Vector3().fromArray(volume), center = rtc && new Vector3().fromArray(rtc);
    const modelCenter = gltfRtc && new Vector3().fromArray(gltfRtc);
    if (modelCenter) {
      // The RTC extension plugin puts this on scene.position. i3dm combines both
      // RTC translations outside the instance rotation/scale and Y→Z correction.
      model.scene.position.sub(modelCenter); model.scene.updateMatrix();
    }
    const matrix = new Matrix4();
    const placement = tile.placementTransform || tile.engineData.transform;
    const inversePlacement = new Matrix4().copy(placement).invert();
    const globalPosition = new Vector3();
    for (let i = 0; i < count; i++) {
      signal.throwIfAborted();
      if (positions) position.fromArray(positions, i * 3);
      else position.fromArray(quantized, i * 3).multiplyScalar(1 / 65535).multiply(quantScale).add(quantOffset);
      if (rtc) position.add(center);
      if (modelCenter) position.add(modelCenter);
      matrix.identity();
      if (up || upOct) {
        if (up) { u.fromArray(up, i * 3); r.fromArray(right, i * 3); }
        else { oct32(upOct, i, u); oct32(rightOct, i, r); }
        if (Math.abs(u.length() - 1) > .001 || Math.abs(r.length() - 1) > .001 || Math.abs(u.dot(r)) > .001) throw new Error('i3dm NORMAL_UP / NORMAL_RIGHT require orthogonal unit vectors.');
        // i3dm's declared basis maps x→right, y→up, z→right×up.
        // Apply this instance transform after the glTF Y→Z conversion.
        matrix.makeBasis(r, u, north.crossVectors(r, u).normalize());
      } else if (features.getData('EAST_NORTH_UP')) {
        globalPosition.copy(position).applyMatrix4(placement);
        if (placement.determinant() === 0 || !this.tiles.ellipsoid.getPositionToSurfacePoint(globalPosition, r)) {
          throw new Error('i3dm ENU requires an invertible tile transform and ECEF position away from the ellipsoid center.');
        }
        const cartographic = this.tiles.ellipsoid.getPositionToCartographic(globalPosition, {});
        this.tiles.ellipsoid.getEastNorthUpFrame(cartographic.lat, cartographic.lon, 0, matrix);
        // Express the final ECEF ENU basis in tile-local coordinates. Normalizing
        // its inverse-mapped axes preserves tile scale instead of cancelling it.
        matrix.premultiply(inversePlacement).extractBasis(r, north, u);
        matrix.makeBasis(r.normalize(), north.normalize(), u.normalize());
      }
      scaling.set(1, 1, 1);
      if (scale3) scaling.fromArray(scale3, i * 3);
      if (scale) scaling.multiplyScalar(scale[i]);
      const instance = new Group();
      instance.matrixAutoUpdate = false;
      instance.matrix.copy(matrix).scale(scaling).setPosition(position).multiply(this.tiles.gltfUpTransform);
      instance.userData.instanceId = i;
      // ponytail: one scene clone/draw per instance preserves every primitive and
      // independent skeleton; batch by primitive only if instance counts demand it.
      instance.add(cloneSkeleton(model.scene));
      scene.add(instance);
    }
    this.tiles.dispatchEvent({ type: 'consume-template', scene: model.scene });
    await this.ownScene(scene, tile, signal);
  }

  async parseGroup(contents, tile, signal) {
    const tiles = this.tiles;
    const entries = await Promise.all(contents.map(async entry => {
      if (!entry.buffer) {
        const response = await tiles.fetchResource(entry.url, { ...tiles.fetchOptions, signal });
        if (!response.ok) throw new Error(`Content load failed: ${entry.url} (${response.status})`);
        entry.buffer = await response.arrayBuffer();
      }
      entry.json = contentJson(entry.buffer);
      return entry;
    }));
    signal.throwIfAborted();
    if (entries.some(entry => entry.json?.root)) return this.expandContents(entries, tile, signal);
    const parts = contents.map(() => ({
      ...tile, contents: undefined,
      internal: { ...tile.internal },
      placementTransform: tile.placementTransform || tile.engineData.transform,
      engineData: { transform: new Matrix4(), scene: null },
      traversal: { visible: false, active: false },
    }));
    const results = await Promise.allSettled(entries.map(async ({ buffer, url }, i) => {
      signal.throwIfAborted();
      const extension = new URL(url).pathname.split('.').pop().toLowerCase();
      const parsed = this.parseTile(buffer, parts[i], extension, url, signal);
      await (parsed || tiles.parseTile(buffer, parts[i], extension, url, signal));
      signal.throwIfAborted();
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) {
      for (const part of parts) if (part.engineData.scene) tiles.disposeTile(part);
      throw failure.reason;
    }
    const scene = new Group();
    scene.add(...parts.map(part => part.engineData.scene));
    await this.ownScene(scene, tile, signal);
  }

  expandContents(entries, tile, signal) {
    signal.throwIfAborted();
    if (tile.children.length) throw new Error('A tile referencing an external tileset cannot define children.');
    const tiles = this.tiles, roots = [], renderable = [];
    if (tile.internal.hasRenderableContent) tile.internal.depthFromRenderedParent--;
    tile.internal.hasRenderableContent = false;
    tile.internal.hasUnrenderableContent = true;
    for (const entry of entries) {
      if (entry.json?.root) {
        if (tile.externalAncestors?.includes(entry.url)) throw new Error('Cyclic external tileset reference.');
        tiles.preprocessTileset(entry.json, entry.url, tile);
        roots.push(entry.json.root);
      } else renderable.push({ uri: entry.url });
    }
    if (renderable.length) {
      const content = { boundingVolume: tile.boundingVolume, geometricError: 0, refine: 'ADD', contents: renderable, internal: { isVirtual: true } };
      tiles.preprocessNode(content, tile.internal.basePath, tile);
      roots.push(content);
    }
    // External roots are simultaneous content branches, not alternative LODs.
    // One renderer owns/traverses/caches them; their transforms inherit this node.
    tile.expandedContents = true;
    for (const root of roots) root.externalContentOwner = tile;
    tile.children.push(...roots);
    return Promise.resolve();
  }

  disposeTile(tile) {
    if (tile.expandedContents) removeChildren(this.tiles, tile);
  }

  async ownScene(scene, tile, signal) {
    const tiles = this.tiles;
    scene.updateMatrix();
    scene.matrix.premultiply(tile.engineData.transform);
    scene.matrixAutoUpdate = false;
    await tiles.invokeAllPlugins(plugin => plugin.processTileModel?.(scene, tile));
    scene.traverse(object => { object.userData.tile = tile; object.frustumCulled = false; });
    const materials = new Set(), geometry = new Set(), textures = new Set();
    scene.traverse(object => {
      if (object.geometry) geometry.add(object.geometry);
      if (object.material) {
        materials.add(object.material);
        for (const value of Object.values(object.material)) if (value?.isTexture) textures.add(value);
      }
    });
    Object.assign(tile.engineData, {
      scene, metadata: null, materials: [...materials], geometry: [...geometry], textures: [...textures],
    });
    markRenderable(tile);
    if (signal.aborted) { tiles.disposeTile(tile); signal.throwIfAborted(); }
  }
}
