import { cellCenter, type TerrainManifest } from '../terrain/package.ts'

export type Policy = 'shortest' | 'gentle'
export type Cell = { row: number; column: number }
export type Rules = { warningSlopeDeg: number; routeSlopeLimitDeg: number; stagingSlopeLimitDeg: number; moveGradeLimitDeg: number; gentleWeight: number }
export type Grid = Pick<TerrainManifest, 'datasetVersion' | 'rows' | 'columns' | 'transform'> & {
  elevation: Float32Array; slope: Float32Array; coverage: Uint8Array; exclusions: Uint8Array
}
export type PathPoint = Cell & {
  index: number; eastM: number; northM: number; elevationM: number; surfaceSlopeDeg: number
  cumulativeDistanceM: number; cumulativeHorizontalDistanceM: number; segmentGradeDeg: number; edgeSurfaceSlopeDeg: number
}
export type Metrics = { distanceM: number; horizontalDistanceM: number; positiveClimbM: number; maxSurfaceSlopeDeg: number; maxAbsGradeDeg: number; warningEdgeCount: number; cost: number; estimatedTimeS: null }
export type Leg = { points: PathPoint[]; metrics: Metrics }
export type Route = {
  status: 'ok'; datasetVersion: string; policy: Policy; start: Cell; target: Cell
  outbound: Leg; returnLeg: Leg; metrics: Metrics; scienceWaypointIndex: number; turnaroundDistanceM: number; expandedCells: number
}
export type Failure = { status: 'outside_coverage' | 'blocked_start' | 'blocked_goal' | 'no_route'; datasetVersion: string; policy: Policy; start: Cell; target: Cell; reason: string }
const degrees = 180 / Math.PI

function validate(grid: Grid, rules: Rules) {
  const count = grid.rows * grid.columns
  if (!Number.isInteger(grid.rows) || !Number.isInteger(grid.columns) || grid.rows < 1 || grid.columns < 1 || count > 0x7fffffff) throw new Error('Invalid grid dimensions')
  if ([grid.elevation, grid.slope, grid.coverage, grid.exclusions].some(a => a.length !== count)) throw new Error('Grid array dimensions do not match')
  const t = grid.transform
  if (!t.every(Number.isFinite) || t[1] * t[5] - t[2] * t[4] === 0) throw new Error('Invalid grid transform')
  if (![rules.warningSlopeDeg, rules.routeSlopeLimitDeg, rules.stagingSlopeLimitDeg, rules.moveGradeLimitDeg].every(n => Number.isFinite(n) && n >= 0 && n < 90) || !Number.isFinite(rules.gentleWeight) || rules.gentleWeight < 0 || rules.routeSlopeLimitDeg <= 0) throw new Error('Invalid routing rules')
  if (rules.warningSlopeDeg > rules.routeSlopeLimitDeg || rules.stagingSlopeLimitDeg > rules.routeSlopeLimitDeg) throw new Error('Warning and staging limits must not exceed route limit')
}

function inside(g: Grid, p: Cell) { return Number.isInteger(p.row) && Number.isInteger(p.column) && p.row >= 0 && p.column >= 0 && p.row < g.rows && p.column < g.columns }
function known(g: Grid, i: number) { return g.coverage[i] === 1 && Number.isFinite(g.elevation[i]) && Number.isFinite(g.slope[i]) && g.slope[i] >= 0 }
function passable(g: Grid, r: Rules, i: number) { return known(g, i) && g.exclusions[i] === 0 && g.slope[i] <= r.routeSlopeLimitDeg }
function horizontal(g: Grid, dr: number, dc: number) { const t = g.transform; return Math.hypot(dc * t[1] + dr * t[2], dc * t[4] + dr * t[5]) }
function grade(g: Grid, a: number, b: number, h: number) { return Math.atan2(g.elevation[b] - g.elevation[a], h) * degrees }

// The two cardinal side cells form a conservative supercover for diagonals.
// All four side transitions are checked, keeping the graph symmetric in grade.
export function edge(g: Grid, rules: Rules, a: number, b: number) {
  const ar = Math.floor(a / g.columns), ac = a % g.columns, br = Math.floor(b / g.columns), bc = b % g.columns
  if (a < 0 || b < 0 || a >= g.rows * g.columns || b >= g.rows * g.columns || !Number.isInteger(a) || !Number.isInteger(b)) return undefined
  const dr = br - ar, dc = bc - ac
  if (Math.max(Math.abs(dr), Math.abs(dc)) !== 1 || !passable(g, rules, a) || !passable(g, rules, b)) return undefined
  const h = horizontal(g, dr, dc), signedGrade = grade(g, a, b, h)
  if (Math.abs(signedGrade) > rules.moveGradeLimitDeg) return undefined
  let surface = Math.max(g.slope[a], g.slope[b])
  if (dr && dc) {
    const sides = [ar * g.columns + bc, br * g.columns + ac]
    for (const s of sides) {
      if (!passable(g, rules, s)) return undefined
      const sr = Math.floor(s / g.columns), sc = s % g.columns
      if (Math.abs(grade(g, a, s, horizontal(g, sr - ar, sc - ac))) > rules.moveGradeLimitDeg || Math.abs(grade(g, b, s, horizontal(g, sr - br, sc - bc))) > rules.moveGradeLimitDeg) return undefined
      surface = Math.max(surface, g.slope[s])
    }
  }
  return { horizontalM: h, lengthM: Math.hypot(h, g.elevation[b] - g.elevation[a]), gradeDeg: signedGrade, surfaceSlopeDeg: surface }
}

type Entry = { index: number; g: number; h: number; f: number }
class Heap {
  items: Entry[] = []
  less(a: Entry, b: Entry) { return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.index < b.index))) }
  push(value: Entry) {
    const a = this.items; a.push(value); let i = a.length - 1
    while (i) { const p = (i - 1) >> 1; if (!this.less(value, a[p])) break; a[i] = a[p]; i = p }
    a[i] = value
  }
  pop() {
    const a = this.items, top = a[0], last = a.pop()!
    if (a.length) { let i = 0; while (i * 2 + 1 < a.length) { let c = i * 2 + 1; if (c + 1 < a.length && this.less(a[c + 1], a[c])) c++; if (!this.less(a[c], last)) break; a[i] = a[c]; i = c }; a[i] = last }
    return top
  }
}
function cost(e: NonNullable<ReturnType<typeof edge>>, r: Rules, policy: Policy) { return e.lengthM * (policy === 'gentle' ? 1 + r.gentleWeight * (e.surfaceSlopeDeg / r.routeSlopeLimitDeg) ** 2 : 1) }
function emptyMetrics(): Metrics { return { distanceM: 0, horizontalDistanceM: 0, positiveClimbM: 0, maxSurfaceSlopeDeg: 0, maxAbsGradeDeg: 0, warningEdgeCount: 0, cost: 0, estimatedTimeS: null } }
function leg(g: Grid, r: Rules, policy: Policy, indices: number[]): Leg {
  const metrics = emptyMetrics(), points: PathPoint[] = []
  for (const [n, index] of indices.entries()) {
    const row = Math.floor(index / g.columns), column = index % g.columns, p = cellCenter(g.transform, row, column)
    const e = n ? edge(g, r, indices[n - 1], index) : undefined
    if (n && !e) throw new Error('Final route edge failed revalidation')
    if (e) {
      metrics.distanceM += e.lengthM; metrics.horizontalDistanceM += e.horizontalM
      metrics.positiveClimbM += Math.max(0, g.elevation[index] - g.elevation[indices[n - 1]])
      metrics.maxAbsGradeDeg = Math.max(metrics.maxAbsGradeDeg, Math.abs(e.gradeDeg)); metrics.cost += cost(e, r, policy)
      if (e.surfaceSlopeDeg > r.warningSlopeDeg) metrics.warningEdgeCount++
    }
    metrics.maxSurfaceSlopeDeg = Math.max(metrics.maxSurfaceSlopeDeg, e?.surfaceSlopeDeg ?? g.slope[index])
    points.push({ index, row, column, eastM: p.x, northM: p.y, elevationM: g.elevation[index], surfaceSlopeDeg: g.slope[index], cumulativeDistanceM: metrics.distanceM, cumulativeHorizontalDistanceM: metrics.horizontalDistanceM, segmentGradeDeg: e?.gradeDeg ?? 0, edgeSurfaceSlopeDeg: e?.surfaceSlopeDeg ?? g.slope[index] })
  }
  return { points, metrics }
}

export function planRoute(g: Grid, rules: Rules, start: Cell, target: Cell, policy: Policy): Route | Failure {
  validate(g, rules)
  if (policy !== 'shortest' && policy !== 'gentle') throw new Error('Unknown route policy')
  const fail = (status: Failure['status'], reason: string): Failure => ({ status, reason, datasetVersion: g.datasetVersion, policy, start, target })
  if (!inside(g, start) || !inside(g, target)) return fail('outside_coverage', 'Endpoint is outside the grid or is not an integer cell; no automatic snapping')
  const a = start.row * g.columns + start.column, b = target.row * g.columns + target.column
  if (!known(g, a) || !known(g, b)) return fail('outside_coverage', 'Endpoint has unknown coverage, elevation or slope')
  if (!passable(g, rules, a)) return fail('blocked_start', 'Start is excluded or above the route surface slope limit')
  if (!passable(g, rules, b)) return fail('blocked_goal', 'Target is excluded or above the route surface slope limit')
  const scores = new Float64Array(g.rows * g.columns).fill(Infinity), previous = new Int32Array(scores.length).fill(-1), closed = new Uint8Array(scores.length)
  const heap = new Heap(), heuristic = (row: number, col: number) => horizontal(g, target.row - row, target.column - col)
  scores[a] = 0; const h = heuristic(start.row, start.column); heap.push({ index: a, g: 0, h, f: h })
  let expandedCells = 0, found = false
  while (heap.items.length) {
    const current = heap.pop(), i = current.index
    if (closed[i] || current.g !== scores[i]) continue
    closed[i] = 1; expandedCells++
    if (i === b) { found = true; break }
    const row = Math.floor(i / g.columns), col = i % g.columns
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nr = row + dr, nc = col + dc
      if ((!dr && !dc) || nr < 0 || nc < 0 || nr >= g.rows || nc >= g.columns) continue
      const j = nr * g.columns + nc
      if (closed[j]) continue
      const e = edge(g, rules, i, j)
      if (!e) continue
      const candidate = scores[i] + cost(e, rules, policy)
      if (candidate < scores[j]) {
        scores[j] = candidate; previous[j] = i; const h = heuristic(nr, nc)
        heap.push({ index: j, g: candidate, h, f: candidate + h })
      }
    }
  }
  if (!found) return fail('no_route', 'No connected path satisfies the configured symmetric constraints')
  const indices: number[] = []
  for (let i = b; i !== -1; i = previous[i]) indices.push(i)
  indices.reverse()
  const outbound = leg(g, rules, policy, indices), returnLeg = leg(g, rules, policy, [...indices].reverse())
  const x = outbound.metrics, y = returnLeg.metrics
  const metrics: Metrics = { distanceM: x.distanceM + y.distanceM, horizontalDistanceM: x.horizontalDistanceM + y.horizontalDistanceM, positiveClimbM: x.positiveClimbM + y.positiveClimbM, maxSurfaceSlopeDeg: Math.max(x.maxSurfaceSlopeDeg, y.maxSurfaceSlopeDeg), maxAbsGradeDeg: Math.max(x.maxAbsGradeDeg, y.maxAbsGradeDeg), warningEdgeCount: x.warningEdgeCount + y.warningEdgeCount, cost: x.cost + y.cost, estimatedTimeS: null }
  return { status: 'ok', datasetVersion: g.datasetVersion, policy, start, target, outbound, returnLeg, metrics, scienceWaypointIndex: indices.length - 1, turnaroundDistanceM: x.distanceM, expandedCells }
}
