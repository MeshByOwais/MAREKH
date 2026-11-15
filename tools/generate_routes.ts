import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { cellCenter, readFloatGrid, type RealTerrainManifest } from '../src/terrain/package.ts'
import { planRoute, type Grid } from '../src/routing/planner.ts'

const root = new URL('../', import.meta.url)
const terrain = new URL('public/sites/columbia-hills/terrain-v1/', root)
const output = new URL('public/sites/columbia-hills/routes-v1/', root)
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const configBytes = await readFile(new URL('config/columbia-hills/routing-v1.json', root))
const config = JSON.parse(configBytes.toString())
const manifestBytes = await readFile(new URL('manifest.json', terrain))
const manifest: RealTerrainManifest = JSON.parse(manifestBytes.toString())
if (manifest.datasetVersion !== config.datasetVersion) throw new Error('Routing configuration dataset mismatch')
const assets = await Promise.all(['elevation.f32', 'slope-deg.f32', 'coverage.u8', 'exclusions.u8', 'mission.json'].map(async name => {
  const data = await readFile(new URL(name, terrain)), entry = manifest.assets[name]
  if (data.length !== entry.bytes || sha(data) !== entry.sha256) throw new Error(`Terrain integrity failure: ${name}`)
  return data
}))
const grid: Grid = { ...manifest, elevation: readFloatGrid(assets[0]), slope: readFloatGrid(assets[1]), coverage: assets[2], exclusions: assets[3] }
const originalMission = JSON.parse(assets[4].toString())

function footprint(spec: typeof config.staging, limit: number) {
  const p = cellCenter(manifest.transform, spec.cell.row, spec.cell.column)
  const bounds = [p.x - spec.footprintWidthM / 2, p.y - spec.footprintHeightM / 2, p.x + spec.footprintWidthM / 2, p.y + spec.footprintHeightM / 2]
  // This site package is north-up. Include every closed cell box touching the footprint.
  if (manifest.transform[2] || manifest.transform[4] || manifest.transform[1] <= 0 || manifest.transform[5] >= 0) throw new Error('Footprint checker requires north-up site grid')
  let maxSlopeDeg = 0
  const cells: number[] = []
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.columns; c++) {
    const q = cellCenter(manifest.transform, r, c), dx = manifest.transform[1] / 2, dy = -manifest.transform[5] / 2
    if (q.x + dx < bounds[0] || q.x - dx > bounds[2] || q.y + dy < bounds[1] || q.y - dy > bounds[3]) continue
    const i = r * grid.columns + c
    if (grid.coverage[i] !== 1 || grid.exclusions[i] || !Number.isFinite(grid.elevation[i]) || !Number.isFinite(grid.slope[i]) || grid.slope[i] > limit) throw new Error(`Footprint is blocked at ${r},${c}`)
    maxSlopeDeg = Math.max(maxSlopeDeg, grid.slope[i]); cells.push(i)
  }
  const siteBounds = manifest.boundsWSEN
  if (bounds[0] < siteBounds[0] || bounds[1] < siteBounds[1] || bounds[2] > siteBounds[2] || bounds[3] > siteBounds[3] || !cells.length) throw new Error('Footprint outside terrain')
  return { cell: spec.cell, eastM: p.x, northM: p.y, elevationM: grid.elevation[spec.cell.row * grid.columns + spec.cell.column], boundsWSEN: bounds, cells, cellCount: cells.length, maxSlopeDeg, slopeLimitDeg: limit, rule: 'Every touched native cell; closed rectangular cell/footprint intersection', geometry: { type: 'Polygon', coordinates: [[[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]], [bounds[0], bounds[1]]]] } }
}
const staging = footprint(config.staging, config.rules.stagingSlopeLimitDeg), approach = footprint(config.approach, config.rules.routeSlopeLimitDeg)
const stagingRing = originalMission.features.find((f: { id: string }) => f.id === 'staging-candidate').geometry.coordinates[0] as number[][]
if (!stagingRing.every(Array.isArray)) throw new Error('Missing staging search area')
const xs = stagingRing.map(p => p[0]), ys = stagingRing.map(p => p[1])
if (staging.boundsWSEN[0] < Math.min(...xs) || staging.boundsWSEN[2] > Math.max(...xs) || staging.boundsWSEN[1] < Math.min(...ys) || staging.boundsWSEN[3] > Math.max(...ys)) throw new Error('Staging footprint exceeds original candidate')
const routes = (['shortest', 'gentle'] as const).map(policy => planRoute(grid, config.rules, config.staging.cell, config.approach.cell, policy))
for (const route of routes) if (route.status !== 'ok') throw new Error(`${route.policy}: ${route.status}; review inputs without silently relaxing limits`)
const mission = { schemaVersion: 1, routeVersion: config.routeVersion, datasetVersion: manifest.datasetVersion, status: 'demo-endpoints-validated-and-connected', approvalScope: 'Demonstration planning constraints only; not operational safety certification', staging, approach: { ...approach, originalProposalEastNorthM: config.approach.proposedEastNorthM, adoptedCenterDisplacementM: Math.hypot(approach.eastM - config.approach.proposedEastNorthM[0], approach.northM - config.approach.proposedEastNorthM[1]) }, scienceSource: originalMission.scienceEvidence, absoluteGeolocationAccuracyM: null }
await mkdir(output, { recursive: true })
const serialized: Record<string, Uint8Array> = {
  'config.json': configBytes,
  'mission.json': new TextEncoder().encode(JSON.stringify(mission, null, 2) + '\n'),
  'routes.json': new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, routeVersion: config.routeVersion, datasetVersion: manifest.datasetVersion, routes }, null, 2) + '\n'),
}
for (const [name, bytes] of Object.entries(serialized)) await writeFile(new URL(name, output), bytes)
await writeFile(new URL('manifest.json', output), JSON.stringify({ schemaVersion: 1, routeVersion: config.routeVersion, datasetVersion: manifest.datasetVersion, terrainManifestSha256: sha(manifestBytes), configSha256: sha(configBytes), crsWkt: manifest.crsWkt, assets: Object.fromEntries(Object.entries(serialized).map(([name, data]) => [name, { bytes: data.length, sha256: sha(data) }])) }, null, 2) + '\n')
console.log(JSON.stringify({ output: fileURLToPath(output), stagingCells: staging.cellCount, stagingMaxSlopeDeg: staging.maxSlopeDeg, approachCenterDisplacementM: mission.approach.adoptedCenterDisplacementM, routes: routes.map(r => r.status === 'ok' ? { policy: r.policy, expandedCells: r.expandedCells, outboundPoints: r.outbound.points.length, ...r.metrics } : r) }, null, 2))
