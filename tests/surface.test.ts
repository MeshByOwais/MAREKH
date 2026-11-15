import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { buildSurface } from '../src/terrain/surface.ts'
import { cellCenter, worldToPixel, readFloatGrid, type RealTerrainManifest } from '../src/terrain/package.ts'

const root = new URL('../public/sites/columbia-hills/terrain-v1/', import.meta.url)
const real: RealTerrainManifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8'))
const fixture = (): RealTerrainManifest => ({ ...real, rows: 5, columns: 5, transform: [0, 1, 0, 0, 0, -1], localOrigin: { eastM: 2.5, northM: -2.5, elevationM: 100 }, render: { stride: 4, verticalScale: 1 } })

test('centre coordinates invert on north-up and sheared grids', () => {
  for (const transform of [real.transform, [100, 2, 0.3, 200, 0.2, -3] as RealTerrainManifest['transform']]) {
    for (const [row, column] of [[0, 0], [5, 9], [494, 494], [989, 989]]) {
      const p = cellCenter(transform, row, column)
      const q = worldToPixel(transform, p.x, p.y)
      assert.ok(Math.abs(q.row - row) < 1e-7 && Math.abs(q.column - column) < 1e-7)
    }
  }
})

test('local coordinates preserve north, east, elevation and texture orientation', () => {
  const mesh = buildSurface(fixture(), new Float32Array(25).fill(102), new Uint8Array(25).fill(1))
  assert.equal(mesh.indices.length, 6)
  assert.deepEqual([...mesh.positions.slice(0, 3)], [-2, 2, -2])
  assert.deepEqual([...mesh.positions.slice(-3)], [2, 2, 2])
  assert.ok(mesh.uv[1] > mesh.uv[mesh.uv.length - 1])
  assert.ok(Math.abs(mesh.uv[0] - 0.1) < 1e-7)
})

test('decimated mesh cannot bridge a missing native cell between sampled vertices', () => {
  const coverage = new Uint8Array(25).fill(1)
  coverage[12] = 0
  assert.equal(buildSurface(fixture(), new Float32Array(25).fill(100), coverage).indices.length, 0)
})

test('non-finite elevations block the display even when coverage is malformed', () => {
  const height = new Float32Array(25).fill(100)
  height[7] = NaN
  assert.equal(buildSurface(fixture(), height, new Uint8Array(25).fill(1)).indices.length, 0)
})

test('real display vertices agree with native projected positions and elevations', () => {
  const height = readFloatGrid(readFileSync(new URL('elevation.f32', root)))
  const coverage = readFileSync(new URL('coverage.u8', root))
  const mesh = buildSurface(real, height, coverage)
  assert.ok(mesh.indices.length / 3 > 400000)
  for (let index = 0; index < mesh.indices.length; index += 1997) {
    const vertex = mesh.indices[index], cell = mesh.cells[vertex]
    assert.equal(coverage[cell], 1)
    const p = cellCenter(real.transform, Math.floor(cell / real.columns), cell % real.columns)
    assert.ok(Math.abs(mesh.positions[3 * vertex] - (p.x - real.localOrigin.eastM)) < 1e-4)
    assert.ok(Math.abs(mesh.positions[3 * vertex + 1] - (height[cell] - real.localOrigin.elevationM)) < 1e-4)
    assert.ok(Math.abs(mesh.positions[3 * vertex + 2] + p.y - real.localOrigin.northM) < 1e-4)
  }
})
