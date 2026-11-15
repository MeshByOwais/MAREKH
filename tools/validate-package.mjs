import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readFloatGrid } from '../src/terrain/package.ts'

const root = new URL('../public/sites/columbia-hills/synthetic/', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'))
assert.equal(manifest.schemaVersion, 1)
assert.equal(manifest.datasetVersion, 'synthetic-plane-1')
assert.equal(manifest.siteId, 'columbia-hills')
assert.equal(manifest.provenance, 'synthetic')
assert.deepEqual(manifest.units, { elevation: 'm', slope: 'deg' })
assert.deepEqual(manifest.storage, { order: 'row-major', floatByteOrder: 'little-endian' })
assert.match(manifest.crsWkt, /3396190/)
assert.equal(manifest.rows, 9)
assert.equal(manifest.columns, 11)
assert.deepEqual(manifest.transform, [0, 5, 0, 0, 0, -5])

const pixels = manifest.rows * manifest.columns
const files = {}
for (const [filename, bytesPerCell] of [
  ['elevation.f32', 4], ['slope-deg.f32', 4], ['coverage.u8', 1], ['exclusions.u8', 1],
]) {
  const bytes = await readFile(new URL(filename, root))
  assert.equal(bytes.length, pixels * bytesPerCell)
  assert.equal(manifest.assets[filename].bytes, bytes.length)
  assert.equal(manifest.assets[filename].sha256, createHash('sha256').update(bytes).digest('hex'))
  files[filename] = bytes
}
const slope = readFloatGrid(files['slope-deg.f32'])
const height = readFloatGrid(files['elevation.f32'])
const expectedSlope = Math.atan(0.5) * 180 / Math.PI
for (let row = 0; row < manifest.rows; row++) {
  for (let col = 0; col < manifest.columns; col++) {
    const i = row * manifest.columns + col
    const border = row === 0 || col === 0 || row === manifest.rows - 1 || col === manifest.columns - 1
    const touchesHole = Math.abs(row - 4) <= 1 && Math.abs(col - 5) <= 1
    assert.equal(files['coverage.u8'][i], border || touchesHole ? 0 : 1)
    assert.equal(files['exclusions.u8'][i], 0)
    assert.equal(height[i], row === 4 && col === 5 ? -9999 : 100 + col * 2.5)
    if (!border && !touchesHole) assert.ok(Math.abs(slope[i] - expectedSlope) < 1e-4)
    else assert.equal(slope[i], -9999)
  }
}
console.log('Terrain package validated. Elevation, slope, NoData, layout, and checksums match.')
