# PLATEAU Wireframe Viewer

View 3D city models as wireframes in your browser.
[Project PLATEAU](https://www.mlit.go.jp/plateau/) is a Japanese Ministry of Land, Infrastructure, Transport and Tourism initiative to develop and release 3D city models. Choose CityGML or 3D Tiles from the public PLATEAU catalog, or open a local file.
Model data is loaded in your browser, not uploaded to the app's server.

![](https://raw.githubusercontent.com/mi2428/plateau-wireframe-viewer/demo/underground-light.gif)
![](https://raw.githubusercontent.com/mi2428/plateau-wireframe-viewer/demo/ground-dark.gif)

## Using the website

### Search PLATEAU datasets

1. [Open the viewer](https://mi2428.github.io/plateau-wireframe-viewer/) and click the magnifying glass in the top-left corner.
2. Choose `CityGML` or `3D Tiles` under `Format`. Enter a municipality name (for example, `新宿`) or a five-digit municipality code (for example, `13104`), then press **Enter**. There is no separate Search button.
3. If you searched by name, select a municipality from the results, then select a model. It downloads directly from PLATEAU to your browser. Online search and loading require an internet connection.

For `CityGML`, you can also search directly by an eight-digit mesh code (for example, `53394653`). Mesh codes are not supported for `3D Tiles`. Available models and areas depend on the catalog.

### Find a municipality or mesh code

- **Municipality code (five digits):** Search by name in the viewer; municipality results show the code alongside the name. Alternatively, enter the name on the government statistics portal's [municipality search page (e-Stat)](https://www.e-stat.go.jp/municipalities/cities/areacode) and read the five-digit standard region code (`標準地域コード`) in the results. You do not need a code to search by name.
- **Mesh code (eight digits, CityGML only):** Select a municipality in the viewer; CityGML model results include their mesh codes. You can also look up a CityGML filename for the area in [PLATEAU Open Data](https://www.mlit.go.jp/plateau/open-data/): the first eight digits of `53394653_ubld_6697_op.gml`, for example, are its mesh code. See the [Statistics Bureau's guide to regional meshes](https://www.stat.go.jp/data/mesh/m_tuite.html) for the code system.

### Open a local file

Click the folder icon in the top-left corner and choose a `.gml`, `.citygml`, `.xml`, or 3D Tiles `tileset.json` file. Extract ZIP archives first. If a referenced file is missing, use the folder icon that appears to select the extracted folder containing the same root file. Local files can be viewed offline once the app is available.

### Navigate the model

Drag to orbit, right-drag to pan, and use the wheel or pinch to zoom. Switch themes at the top left. The `GML LOD` controls at the top right select the level of detail for CityGML (`Auto` shows the highest LOD per feature; `All` overlaps every LOD). The bottom-left controls fit the model, switch between isometric and top views or perspective and orthographic projection, and start an automatic orbit. Use the × button to cancel loading or close the model.

## Run locally

Requires Node.js 22.12 or later:

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/` in your browser.

Software and decoder notices are in `public/NOTICE.txt`. This app is licensed under [MIT](LICENSE).
