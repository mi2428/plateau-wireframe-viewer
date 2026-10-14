import cdt2d from 'cdt2d';

const epsilon = 1e-7;
const xy = point => [point[0], point[2]];
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const between = (value, a, b) => value >= Math.min(a, b) - epsilon && value <= Math.max(a, b) + epsilon;
const onSegment = (p, a, b) => Math.abs(cross(a, b, p)) <= epsilon * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])) && between(p[0], a[0], b[0]) && between(p[1], a[1], b[1]);

function crossesTriangle(a, b, triangle) {
  const orientation = Math.sign(cross(...triangle));
  let start = 0, end = 1;
  // Clip to the strict interior: lying on an edge or touching a vertex is not crossing a stopline.
  for (let i = 0; i < 3; i++) {
    const p = triangle[i], q = triangle[(i + 1) % 3];
    const tolerance = epsilon * Math.hypot(q[0] - p[0], q[1] - p[1]);
    const da = orientation * cross(p, q, a), db = orientation * cross(p, q, b);
    if (da <= tolerance && db <= tolerance) return false;
    if (da <= tolerance) start = Math.max(start, (tolerance - da) / (db - da));
    if (db <= tolerance) end = Math.min(end, (da - tolerance) / (da - db));
    if (start >= end) return false;
  }
  return start < end;
}

export function triangulateTin(controlPoints, breakLines, stopLines, maxLength) {
  if (!Number.isFinite(maxLength) || maxLength <= 0) throw new Error('TIN maxLength must be positive and finite.');
  const points = [], index = new Map(), edges = [];
  function add(point) {
    if (point.length !== 3 || !point.every(Number.isFinite)) throw new Error('Invalid TIN control point.');
    const key = `${point[0]},${point[2]}`;
    if (index.has(key)) {
      const id = index.get(key);
      if (Math.abs(points[id][1] - point[1]) > epsilon) throw new Error('Different elevations at the same TIN planar coordinates.');
      return id;
    }
    index.set(key, points.length);
    points.push(point);
    return points.length - 1;
  }
  controlPoints.forEach(add);
  if (points.length < 3) throw new Error('Tin requires at least three distinct controlPoint values.');
  for (const line of breakLines) {
    const ids = line.map(add);
    for (let i = 1; i < ids.length; i++) {
      if (ids[i - 1] === ids[i]) throw new Error('TIN breakLines contain a zero-length segment.');
      edges.push([ids[i - 1], ids[i]]);
    }
  }
  // ponytail: quadratic constraint cleanup; use a spatial PSLG cleaner if very large TINs require it.
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const [a, b] = edges[i].map(id => points[id]), [c, d] = edges[j].map(id => points[id]);
      const u = [b[0] - a[0], b[2] - a[2]], v = [d[0] - c[0], d[2] - c[2]];
      const determinant = u[0] * v[1] - u[1] * v[0];
      if (determinant === 0) continue;
      const w = [c[0] - a[0], c[2] - a[2]];
      const t = (w[0] * v[1] - w[1] * v[0]) / determinant, s = (w[0] * u[1] - w[1] * u[0]) / determinant;
      if (t <= 0 || t >= 1 || s <= 0 || s >= 1) continue;
      const height = a[1] + t * (b[1] - a[1]);
      if (Math.abs(height - (c[1] + s * (d[1] - c[1]))) > epsilon) throw new Error('TIN breakLines have conflicting elevations at an intersection.');
      add([a[0] + t * u[0], height, a[2] + t * u[1]]);
    }
  }
  const constraints = new Map();
  for (const [start, end] of edges) {
    const a = points[start], b = points[end], lengthSquared = (b[0] - a[0]) ** 2 + (b[2] - a[2]) ** 2;
    const ids = points.map((point, id) => ({ id, t: ((point[0] - a[0]) * (b[0] - a[0]) + (point[2] - a[2]) * (b[2] - a[2])) / lengthSquared }))
      .filter(({ id }) => onSegment(xy(points[id]), xy(a), xy(b))).sort((a, b) => a.t - b.t);
    for (const { id, t } of ids) if (Math.abs(points[id][1] - (a[1] + t * (b[1] - a[1]))) > epsilon) throw new Error('TIN control point elevation conflicts with breakLines.');
    for (let i = 1; i < ids.length; i++) {
      const edge = [ids[i - 1].id, ids[i].id].sort((a, b) => a - b);
      if (edge[0] !== edge[1]) constraints.set(edge.join(','), edge);
    }
  }
  const stopSegments = stopLines.flatMap(line => line.slice(1).map((point, i) => [xy(line[i]), xy(point)]));
  const cells = cdt2d(points.map(xy), [...constraints.values()]);
  const retained = cells.filter(cell => {
    const triangle = cell.map(id => points[id]), planar = triangle.map(xy);
    if (triangle.some((point, i) => Math.hypot(...point.map((value, axis) => value - triangle[(i + 1) % 3][axis])) > maxLength)) return false;
    // GML stopLines are line constraints, not polygon exterior/interior rings. A closed line
    // excludes triangles crossing its segments; it does not declare a filled exclusion region.
    return !stopSegments.some(([a, b]) => crossesTriangle(a, b, planar));
  });
  if (!retained.length) throw new Error('No triangles satisfy TIN constraints (check collinearity, maxLength and stopLines).');
  return retained.map(cell => ({ kind: 'ring', points: [...cell.map(id => points[id]), points[cell[0]]] }));
}
