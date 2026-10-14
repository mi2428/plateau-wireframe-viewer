import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadGml } from './gml.js';
import { loadTiles } from './tiles.js';
import { createFileSource } from './source.js';
import { createPlateauSource, searchPlateau } from './plateau.js';
import { fitModel, createBirdOrbit } from './camera.js';
import { surfaces, palette } from './palette.js';
import './style.css';

const $ = id => document.getElementById(id);
const errorMessage = error => error?.message || error?.error || String(error);
const status = (message, error = false) => {
  $('status').textContent = message;
  $('status').dataset.error = String(error);
};

async function start() {
  const renderer = new THREE.WebGLRenderer({ canvas: $('canvas'), antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const perspective = new THREE.PerspectiveCamera(45, 1, .01, 100000);
  const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, .01, 100000);
  let camera = perspective;
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let model = null, controller = null, source = null, sourceType = null, generation = 0, searchController = null, view = 'iso', themeValue = 'dark', birdOrbit = null;
  const legend = surfaces.map(([name, label]) => {
    const item = document.createElement('li');
    item.textContent = label;
    item.dataset.surface = name;
    $('legend').append(item);
    return item;
  });
  function theme() {
    document.documentElement.dataset.theme = themeValue;
    const action = `Switch to ${themeValue === 'dark' ? 'light' : 'dark'} theme`;
    $('themeBtn').title = action;
    $('themeBtn').setAttribute('aria-label', action);
    $('themeBtn').setAttribute('aria-pressed', String(themeValue === 'light'));
    const colorOf = palette(themeValue);
    for (const item of legend) item.style.setProperty('--swatch', colorOf(item.dataset.surface));
    model?.setTheme(themeValue);
  }
  $('themeBtn').addEventListener('click', () => { themeValue = themeValue === 'dark' ? 'light' : 'dark'; theme(); });
  theme();

  function resize() {
    const { width, height } = $('stage').getBoundingClientRect();
    const aspect = width / height;
    renderer.setSize(width, height, false);
    perspective.aspect = aspect;
    orthographic.aspect = aspect;
    orthographic.left = -orthographic.top * aspect;
    orthographic.right = orthographic.top * aspect;
    perspective.updateProjectionMatrix();
    orthographic.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe($('stage'));
  resize();

  function birdMode(active) {
    birdOrbit = active && model ? createBirdOrbit(camera, controls.target) : null;
    const label = birdOrbit ? 'Stop bird flight' : 'Fly around model';
    $('birdBtn').setAttribute('aria-pressed', String(!!birdOrbit));
    $('birdBtn').setAttribute('aria-label', label);
    $('birdBtn').title = label;
  }
  const fit = () => { birdMode(false); if (model) fitModel(camera, controls, model.bounds, view); };
  function resetModel() {
    birdMode(false);
    $('birdBtn').disabled = true;
    generation++;
    controller?.abort();
    if (model) { scene.remove(model.group); model.dispose(); model = null; }
    $('details').textContent = '';
  }
  async function loadSelectedModel() {
    if (!source) return;
    const id = generation;
    controller = new AbortController();
    $('folderBtn').hidden = true;
    status('Loading…');
    let next;
    try {
      const selectedLod = document.querySelector('[name=lod]:checked').value;
      const options = {
        source, signal: controller.signal, renderer, theme: themeValue,
        lod: ['highest', 'all'].includes(selectedLod) ? selectedLod : Number(selectedLod),
        onError: error => {
          if (id !== generation) return;
          status(`Load failed: ${errorMessage(error)}`, true);
          $('folderBtn').hidden = !/Missing selected file:/.test(errorMessage(error));
        },
      };
      next = sourceType === 'gml' ? await loadGml(source.url, options) : await loadTiles(source.url, options);
      if (id !== generation) { next.dispose(); return; }
      if (next.bounds.isEmpty()) throw new Error('No visible geometry for the selected LOD.');
      model = next;
      model.setTheme(themeValue);
      scene.add(model.group);
      $('birdBtn').disabled = false;
      fit();
      const size = model.bounds.getSize(new THREE.Vector3());
      $('details').textContent = `${model.description} · ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} m`;
      status(`Viewing: ${source.name}`);
    } catch (error) {
      if (next && next !== model) next.dispose();
      if (id !== generation || controller.signal.aborted) return;
      status(`Load failed: ${errorMessage(error)}`, true);
      $('folderBtn').hidden = !/Missing selected file:/.test(errorMessage(error));
    }
  }

  $('openBtn').addEventListener('click', () => $('mainFile').click());
  $('plateauBtn').addEventListener('click', () => $('plateauDialog').showModal());
  $('plateauDialog').addEventListener('click', event => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.currentTarget.close();
  });
  $('plateauDialog').addEventListener('close', () => searchController?.abort());
  $('plateauKind').addEventListener('change', () => {
    searchController?.abort();
    const gml = $('plateauKind').value === 'gml';
    $('plateauCodeLabel').textContent = gml ? '8-digit mesh code' : '5-digit municipality code';
    $('plateauCode').placeholder = gml ? '53394653' : '13106';
    $('plateauCode').value = '';
    $('plateauResults').replaceChildren();
    $('plateauMessage').textContent = '';
  });
  $('plateauCode').addEventListener('input', () => { searchController?.abort(); $('plateauResults').replaceChildren(); $('plateauMessage').textContent = ''; });
  $('plateauSearch').addEventListener('submit', async event => {
    event.preventDefault();
    searchController?.abort();
    const request = new AbortController();
    searchController = request;
    $('plateauResults').replaceChildren();
    $('plateauMessage').dataset.error = 'false';
    $('plateauMessage').textContent = 'Searching PLATEAU…';
    try {
      const results = await searchPlateau($('plateauKind').value, $('plateauCode').value.trim(), request.signal);
      if (request.signal.aborted) return;
      $('plateauMessage').textContent = results.length ? `${results.length} results. Select a model to download.` : 'No matching files.';
      for (const result of results) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = result.label;
        button.addEventListener('click', () => {
          try {
            const selected = createPlateauSource(result.url, result.kind, result.label);
            resetModel();
            source?.dispose();
            source = selected;
            sourceType = result.kind;
            $('folderBtn').hidden = true;
            $('cancelBtn').disabled = false;
            $('plateauDialog').close();
            loadSelectedModel();
          } catch (error) { $('plateauMessage').dataset.error = 'true'; $('plateauMessage').textContent = errorMessage(error); }
  });
        $('plateauResults').append(button);
      }
    } catch (error) {
      if (!request.signal.aborted) { $('plateauMessage').dataset.error = 'true'; $('plateauMessage').textContent = errorMessage(error); }
    }
  });
  $('mainFile').addEventListener('change', () => {
    const file = $('mainFile').files[0];
    $('mainFile').value = '';
    if (!file) return;
    resetModel();
    source?.dispose();
    source = null;
    $('folderBtn').hidden = true;
    try {
      sourceType = /\.(gml|citygml|xml)$/i.test(file.name) ? 'gml' : /\.json$/i.test(file.name) ? 'tiles' : null;
      if (!sourceType) throw new Error('Choose a GML file or a 3D Tiles tileset JSON. Extract ZIP files first.');
      source = createFileSource(file);
      $('cancelBtn').disabled = false;
      loadSelectedModel();
    } catch (error) { $('cancelBtn').disabled = true; status(`Load failed: ${errorMessage(error)}`, true); }
  });
  $('folderBtn').addEventListener('click', () => $('folderFile').click());
  $('folderFile').addEventListener('change', async () => {
    const files = [...$('folderFile').files];
    $('folderFile').value = '';
    if (!files.length || !source) return;
    resetModel();
    const id = generation, selected = source;
    status('Checking selected folder…');
    try {
      await selected.selectFolder(files);
      if (id === generation) loadSelectedModel();
    } catch (error) {
      if (id === generation) status(`Folder rejected: ${errorMessage(error)}`, true);
    }
  });
  $('cancelBtn').addEventListener('click', () => {
    resetModel();
    source?.dispose();
    source = null;
    sourceType = null;
    $('folderBtn').hidden = true;
    $('cancelBtn').disabled = true;
    status('Loading canceled; model closed.');
  });
  document.querySelectorAll('[name=lod]').forEach(input => input.addEventListener('change', () => {
    if (sourceType === 'gml') { resetModel(); loadSelectedModel(); }
  }));
  $('fitBtn').addEventListener('click', fit);
  $('birdBtn').addEventListener('click', () => birdMode(!birdOrbit));
  controls.addEventListener('start', () => { if (birdOrbit) birdMode(false); });
  for (const [id, pose] of [['isoBtn', 'iso'], ['topBtn', 'top']]) {
    $(id).addEventListener('click', () => {
      view = pose;
      $('isoBtn').setAttribute('aria-pressed', String(view === 'iso'));
      $('topBtn').setAttribute('aria-pressed', String(view === 'top'));
      fit();
    });
  }
  $('projectionBtn').addEventListener('click', () => {
    camera = camera === perspective ? orthographic : perspective;
    controls.object = camera;
    const orthographicView = camera === orthographic;
    $('projectionBtn').setAttribute('aria-pressed', String(orthographicView));
    const label = `${orthographicView ? 'Orthographic' : 'Perspective'} projection; switch to ${orthographicView ? 'perspective' : 'orthographic'}`;
    $('projectionBtn').title = label;
    $('projectionBtn').setAttribute('aria-label', label);
    fit();
  });

  let lastFrame = 0;
  renderer.setAnimationLoop(time => {
    birdOrbit?.(lastFrame ? (time - lastFrame) / 1000 : 0);
    lastFrame = time;
    controls.update();
    model?.update?.(camera, renderer);
    renderer.render(scene, camera);
  });
  addEventListener('pagehide', () => { resetModel(); source?.dispose(); controls.dispose(); renderer.dispose(); });
}

start().catch(error => status(`Initialization failed: ${errorMessage(error)}`, true));
