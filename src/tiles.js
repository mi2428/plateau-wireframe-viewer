import * as THREE from 'three';
import { GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/three/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { LocalTilesRenderer, LocalImplicitTilingPlugin, TileContentsPlugin, validateGltf, tileResourceUrl } from './tiles-support.js';
import { palette } from './palette.js';

function releaseObjectBuffers(scene) {
  scene.traverse(object => {
    if (object.isInstancedMesh) object.dispose();
    if (object.isSkinnedMesh) object.skeleton.dispose();
  });
}

function releaseScene(scene, styled, color) {
  const materials = new Set(), textures = new Set(), images = new Set(), geometries = new Set();
  scene.traverse(object => {
    if (styled && (!object.material || styled.has(object))) return;
    for (const material of [].concat(object.material || [])) materials.add(material);
    if (styled) {
      if (object.isMesh) object.material = new THREE.MeshBasicMaterial({ color, wireframe: true, side: THREE.DoubleSide });
      else if (object.isPoints) object.material = new THREE.PointsMaterial({ color: object.geometry.hasAttribute('color') ? 0xffffff : color, vertexColors: object.geometry.hasAttribute('color'), size: 2, sizeAttenuation: false });
      else if (object.isLine) object.material = new THREE.LineBasicMaterial({ color });
      else throw new Error(`Unsupported render primitive: ${object.type}`);
      styled.add(object);
    } else if (object.geometry) {
      geometries.add(object.geometry);
    }
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) images.add(texture.image);
    texture.dispose();
  }
  for (const image of images) image.close();
  for (const geometry of geometries) geometry.dispose();
  if (!styled) releaseObjectBuffers(scene);
}

export async function loadTiles(url, { source, signal, renderer, onError, theme = 'dark' } = {}) {
  signal?.throwIfAborted();
  palette(theme);
  if (!source) throw new Error('Choose a local tileset JSON file.');
  const rootUrl = source.resolve(url);
  const tiles = new LocalTilesRenderer(rootUrl, source);
  const lifetime = new AbortController();
  tiles.fetchOptions = { signal: lifetime.signal, redirect: 'error' };
  const pendingScenes = new Set();
  const styled = new WeakSet();
  let disposed = false, currentCamera, rejectLoad;
  const aborted = () => signal?.reason || new DOMException('3D Tiles loading canceled.', 'AbortError');

  // Decoder URLs are fixed here, not read from the dataset.
  const decoderManager = new THREE.LoadingManager();
  const appBase = new URL(import.meta.env?.BASE_URL || '/', location.href);
  const decoders = new Set(['draco/draco_decoder.js', 'draco/draco_decoder.wasm', 'draco/draco_wasm_wrapper.js',
    'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm'].map(path => new URL(`decoders/${path}`, appBase).href));
  const draco = new DRACOLoader(decoderManager).setDecoderPath(new URL('decoders/draco/', appBase).href);
  const ktx = new KTX2Loader(decoderManager).setTranscoderPath(new URL('decoders/basis/', appBase).href);
  if (renderer) ktx.detectSupport(renderer);

  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', cancel);
    lifetime.abort();
    tiles.manager.abort();
    decoderManager.abort();
    tiles.dispose();
    for (const scene of pendingScenes) releaseScene(scene);
    pendingScenes.clear();
    tiles.group.clear();
    draco.dispose();
    // three r186 decrements its active-loader count even if init() was never called.
    if (ktx.transcoderPending) ktx.dispose();
  }

  function cancel() {
    rejectLoad?.(aborted());
    dispose();
  }

  function fail(error) {
    if (disposed) return;
    if (!(error instanceof Error)) error = new Error(error?.error ?? String(error), { cause: error });
    rejectLoad?.(error);
    dispose();
    onError?.(error);
  }

  tiles.fetchResource = async (value, options = {}) => {
    lifetime.signal.throwIfAborted();
    const resource = tileResourceUrl(value, rootUrl, source);
    const request = {
      ...options,
      signal: AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]),
    };
    return resource.startsWith('data:') ? fetch(resource, request) : source.fetch(resource, request);
  };

  tiles.registerPlugin({
    name: 'LOCAL_TILES_SOURCE',
    async fetchData(value, options) {
      const response = await tiles.fetchResource(value, options);
      if (options.signal === lifetime.signal) return response;
      if (!response.ok) throw new Error(`3D Tiles content load failed: ${value} (${response.status})`);
      // Every content reaches the parser as bytes. Upstream's suffix-only JSON
      // branch must not mistake the first of multiple contents for the whole tile.
      return response.arrayBuffer();
    },
    processTileModel(scene) {
      for (const pending of pendingScenes) {
        for (let parent = pending.parent; parent; parent = parent.parent) {
          if (parent === scene) { pendingScenes.delete(pending); break; }
        }
      }
      pendingScenes.add(scene);
      // Keep affine tile transforms (including shear), instances, skins and topology.
      scene.matrixAutoUpdate = false;
      releaseScene(scene, styled, palette(theme)('Unclassified'));
      if (disposed) {
        releaseScene(scene);
        pendingScenes.delete(scene);
        throw aborted();
      }
    },
  });

  function resourceUrl(value, decoder = false) {
    try {
      lifetime.signal.throwIfAborted();
      const resource = new URL(value, rootUrl);
      if (resource.protocol === 'data:') return resource.href;
      if (resource.protocol === 'blob:' && (resource.origin === new URL(location.href).origin || source.ownsObjectUrl(resource.href))) return resource.href;
      if (decoder && decoders.has(resource.href)) {
        return resource.href;
      }
      return source.objectUrl(source.resolve(value, rootUrl));
    } catch (error) {
      // GLTFLoader can swallow texture errors; fail visibly before it issues a request.
      fail(error);
      throw error;
    }
  }
  tiles.manager.setURLModifier(value => resourceUrl(value));
  // KTX2Loader uses its own manager for both textures and the fixed decoder files.
  decoderManager.setURLModifier(value => resourceUrl(value, true));
  tiles.manager.onError = value => fail(new Error(`3D Tiles dependency load failed: ${value}`));
  decoderManager.onError = value => fail(new Error(`Local decoder load failed: ${value}`));
  const gltfOptions = {
    metadata: false,
    dracoLoader: draco,
    ktxLoader: ktx,
    meshoptDecoder: MeshoptDecoder,
    autoDispose: false,
    plugins: [parser => ({
      name: 'LOCAL_TILES_LIFETIME',
      beforeRoot() {
         validateGltf(parser);
         for (const item of [...(parser.json.buffers || []), ...(parser.json.images || [])]) {
           if (item.uri) tileResourceUrl(item.uri, parser.options.path, source);
         }
      },
      afterRoot(result) {
        // Keep not-yet-owned GLTF scenes so cancellation during parse also frees them.
        for (const scene of result.scenes) pendingScenes.add(scene);
        if (disposed) {
          for (const scene of result.scenes) { releaseScene(scene); pendingScenes.delete(scene); }
          throw aborted();
        }
      },
    })],
  };
  tiles.registerPlugin(new GLTFExtensionsPlugin(gltfOptions));
  tiles.registerPlugin(new LocalImplicitTilingPlugin());
  tiles.registerPlugin(new TileContentsPlugin());
  tiles.registerPlugin(new ReorientationPlugin({ up: '+z', recenter: true }));
  tiles.addEventListener('dispose-model', ({ scene }) => {
    pendingScenes.delete(scene);
    releaseObjectBuffers(scene);
  });
  tiles.addEventListener('discard-model', ({ tile }) => {
    for (const scene of pendingScenes) if (scene.userData.tile === tile) {
      releaseScene(scene); pendingScenes.delete(scene);
    }
  });
  tiles.addEventListener('consume-template', ({ scene, unused }) => {
    pendingScenes.delete(scene);
    if (unused) releaseScene(scene); else releaseObjectBuffers(scene);
  });
  tiles.addEventListener('load-error', ({ error }) => fail(error));

  return new Promise((resolve, reject) => {
    rejectLoad = reject;
    tiles.addEventListener('load-root-tileset', () => {
      if (disposed) return;
      try {
        const bounds = new THREE.Box3(), transform = new THREE.Matrix4();
        if (!tiles.getOrientedBoundingBox(bounds, transform)) throw new Error('Root has no bounds.');
        tiles.group.updateMatrixWorld(true);
        bounds.applyMatrix4(transform.premultiply(tiles.group.matrix));
        if (bounds.isEmpty() || ![...bounds.min, ...bounds.max].every(Number.isFinite)) {
          throw new Error('Invalid root boundingVolume / transform.');
        }
        const center = bounds.getCenter(new THREE.Vector3());
        tiles.group.position.sub(center);
        tiles.group.updateMatrixWorld(true);
        bounds.translate(center.negate());
        resolve({
          group: tiles.group,
          bounds,
          description: '3D Tiles 1.0 / 1.1 · mesh triangle edges (not original polygon boundaries) / lines / points',
          update(camera, activeRenderer = renderer) {
            if (disposed) return;
            if (currentCamera !== camera) {
              if (currentCamera) tiles.deleteCamera(currentCamera);
              tiles.setCamera(camera);
              currentCamera = camera;
            }
            tiles.setResolutionFromRenderer(camera, activeRenderer);
            camera.updateMatrixWorld();
            tiles.group.updateMatrixWorld(true);
            try { tiles.update(); } catch (error) { fail(error); }
          },
          dispose,
          setTheme(value) {
            const color = palette(value)('Unclassified');
            theme = value;
            const recolor = scene => scene.traverse(object => {
              if (styled.has(object) && !object.material.vertexColors) object.material.color.set(color);
            });
            tiles.forEachLoadedModel(recolor);
            for (const scene of pendingScenes) recolor(scene);
          },
        });
      } catch (error) {
        fail(error);
      }
    });
    signal?.addEventListener('abort', cancel, { once: true });
    tiles.update();
  });
}
