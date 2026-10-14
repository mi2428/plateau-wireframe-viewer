# PLATEAU Wireframe Viewer

Explore 3D city models from Japan's [Project PLATEAU](https://www.mlit.go.jp/plateau/) as wireframes in your browser.
Search public CityGML and 3D Tiles or open local files; model data loads directly in your browser without being uploaded to the app's server.

![](https://raw.githubusercontent.com/mi2428/plateau-wireframe-viewer/demo/underground-light.gif)
![](https://raw.githubusercontent.com/mi2428/plateau-wireframe-viewer/demo/ground-dark.gif)

## Usage

### Browse online models

1. [Open the viewer](https://mi2428.github.io/plateau-wireframe-viewer/) and click the magnifying glass.
2. Choose `CityGML` or `3D Tiles`, enter a municipality name (`新宿`) or five-digit code (`13104`), and press **Enter**.
3. If you searched by name, select the municipality, then a model.
   The viewer queries the PLATEAU API and downloads the model directly to your browser; an internet connection is required.

Codes are optional when searching by name: municipality results display the five-digit code, which you can also look up on [e-Stat](https://www.e-stat.go.jp/municipalities/cities/areacode).
For `CityGML` only, you can search by an eight-digit mesh code (`53394653`); find it in the model results or as the first eight digits of CityGML filenames in [PLATEAU Open Data](https://www.mlit.go.jp/plateau/open-data/).

### Open local models

Click the folder icon to open your own CityGML (`.gml`, `.citygml`, `.xml`) or 3D Tiles (`tileset.json`), including non-PLATEAU models.
Extract ZIP archives first; if a referenced file is missing, select the extracted folder containing the same root file when prompted.
Local models work offline once the app is available.

With either source, drag to orbit, right-drag to pan, and use the wheel or pinch to zoom.
The corner controls change the theme, view, projection, automatic orbit, and CityGML LOD; × cancels loading or closes the model.

## License

This app is licensed under [MIT](LICENSE).
