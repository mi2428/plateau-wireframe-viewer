# PLATEAU Wireframe Viewer

A static, browser-only viewer for user-selected local CityGML and 3D Tiles, or public PLATEAU datasets selected through the optional online catalog. The hosting server serves only the app; model data is never uploaded.

## Open a model

- **Local, offline:** choose a `.gml`, `.citygml`, `.xml`, or 3D Tiles `tileset.json` with the folder icon. If a referenced file is missing, choose an extracted folder containing the *same root file* when prompted. The viewer matches its name, size, and SHA-256 content before reading referenced files. Extract ZIPs beforehand; arbitrary files, external references, and server-side fallbacks are not used.
- **PLATEAU online:** click the magnifying glass, enter a municipality name (for example `新宿`), a five-digit municipality code (for example `13104`), or an eight-digit CityGML mesh code (for example `53394536`), and press Enter. For names, select the municipality first; then choose a model to download directly from the official PLATEAU API/assets to the browser. Catalog availability and format may change.

Local mode needs no network connection after the static app is available. The optional online mode needs access only to the official PLATEAU hosts. No CDN, map, tile service, upload endpoint, or `/data` mount is required.

## Controls and formats

Drag to orbit, right-drag to pan, and wheel/pinch to zoom. The corner controls switch theme, GML LOD (`Auto`: highest per feature; `All`: overlapping LODs), view, and projection. The bird button starts/stops an automatic orbit with gentle elevation changes; manual movement and view buttons also stop it. GML line width adapts to screen scale. The legend remains visible.

CityGML draws original exterior/interior polygon edges, curves, points, and constrained TIN triangles. Its 14-color palette uses explicit semantic surface types; unspecified geometry remains neutral, and RGB points retain their source colors. 3D Tiles draws mesh triangle edges (not original GML boundaries), lines, and points. The viewer supports GML xlinks, implicit geometry, dependent LAS/LAZ, EPSG:6697/6668/4326 and JGD2011 plane EPSG:6669–6687; 3D Tiles 1.0/1.1 with glTF/GLB/b3dm/pnts/i3dm/cmpt/implicit tiling and bundled Draco/Meshopt/KTX2 decoders. Invalid or unsupported references, CRS, geometry, and required extensions fail visibly.

Large GML/point clouds are held in browser memory. A single LAZ raw decode is limited to 1 GiB. No geoid/epoch conversion, inferred floors, GIS editing, or standalone LAS/OBJ/FBX import is provided.

## Run and verify

Node.js 22.12 or later:

```sh
npm ci
npm run check
npm run build
npx playwright install chromium
npm run check:browser
```

Run `check` and `build` serially because they prepare the same bundled decoders. Chromium installation is needed only once per Playwright version. The browser check serves only `dist/` at an ephemeral local port and tests both `/` and `/viewer/`. If hadolint is installed, run `hadolint Dockerfile` to lint the container definition.

The same `dist/` works at a site root or GitHub Pages project subpath (`base: './'`). App assets, notices, Workers, and bundled decoders use deployment-relative URLs. Synthetic fixtures live in `test/fixtures/` and are never copied into the build.

For local debugging with Vite and live source updates:

```sh
docker compose up --build
```

Open `http://127.0.0.1:5173/` in a browser and use its developer tools. Edits to `src/`, `index.html`, and `vite.config.js` are reflected without rebuilding; rebuild after changing dependencies or other files copied by the Dockerfile. Stop with Ctrl+C (or `docker compose down` if started in the background).

Alternatively, serve the app in Docker:

```sh
docker build -t plateau-wireframe-viewer .
docker run --rm -p 127.0.0.1:8080:80 plateau-wireframe-viewer
```

Open `http://127.0.0.1:8080/` and choose a local file or a PLATEAU catalog result. Docker serves only static app assets; no model-data volume is needed.

Software and decoder attribution is in `public/NOTICE.txt` and the generated `third-party-licenses.md`. The application is licensed under the MIT License (see `LICENSE`).
