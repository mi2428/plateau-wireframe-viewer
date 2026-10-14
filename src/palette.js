export const surfaces = [
  ['FloorSurface', 'Floor surface', '#4de1ff', '#08728d'],
  ['InteriorWallSurface', 'Interior wall', '#ecf3f7', '#435267'],
  ['WallSurface', 'Wall surface', '#91a9b8', '#3a5563'],
  ['CeilingSurface', 'Ceiling surface', '#b794f6', '#6742a4'],
  ['Door', 'Door', '#ffbf69', '#985900'],
  ['Window', 'Window', '#52d6c8', '#087d72'],
  ['ClosureSurface', 'Closure surface', '#ff6b9a', '#a92a55'],
  ['IntBuildingInstallation', 'Interior building installation', '#ffd166', '#865800'],
  ['BuildingInstallation', 'Building installation', '#f4a261', '#9c4b15'],
  ['GroundSurface', 'Ground surface', '#47748d', '#356078'],
  ['RoofSurface', 'Roof surface', '#8093f1', '#4558b5'],
  ['OuterFloorSurface', 'Outer floor', '#5bb8d1', '#197f9b'],
  ['OuterCeilingSurface', 'Outer ceiling', '#7f6ba8', '#5c4083'],
  ['Unclassified', 'Unclassified', '#a7b4be', '#4e5b68'],
];

const styles = new Map(surfaces.map(([name, label, dark, light]) => [name, { label, dark, light }]));
export const semanticType = node => /^http:\/\/www\.opengis\.net\/citygml(?:\/[^/]+)?\/2\.0$/.test(node.namespaceURI) && styles.has(node.localName) && node.localName !== 'Unclassified' ? node.localName : null;

export function palette(theme) {
  if (!['dark', 'light'].includes(theme)) throw new Error(`Unknown theme: ${theme}`);
  return name => styles.get(name)?.[theme] ?? styles.get('Unclassified')[theme];
}
