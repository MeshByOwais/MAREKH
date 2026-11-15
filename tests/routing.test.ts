import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import { hasConnectedPath } from '../src/routing/fixture-check.ts'
import { cellCenter, type TerrainManifest } from '../src/terrain/package.ts'

const folder = new URL('../public/sites/columbia-hills/synthetic/', import.meta.url)
const manifest: TerrainManifest = JSON.parse(readFileSync(new URL('manifest.json', folder), 'utf8'))
const coverage = readFileSync(new URL('coverage.u8', folder))
const exclusions = readFileSync(new URL('exclusions.u8', folder))
const cell = (row: number, column: number) => row * manifest.columns + column

test('can reach the other side of the fixture around missing terrain', () => {
  assert.equal(hasConnectedPath(coverage, exclusions, manifest.columns, cell(4, 2), cell(4, 8)), true)
})

test('rejects a start or target with missing terrain', () => {
  assert.equal(hasConnectedPath(coverage, exclusions, manifest.columns, cell(4, 5), cell(4, 8)), false)
  assert.equal(hasConnectedPath(coverage, exclusions, manifest.columns, cell(4, 2), cell(4, 5)), false)
})

test('reports a disconnected route when exclusions cut the grid', () => {
  const barrier = new Uint8Array(exclusions)
  for (let row = 0; row < manifest.rows; row++) barrier[cell(row, 5)] = 1
  assert.equal(hasConnectedPath(coverage, barrier, manifest.columns, cell(4, 2), cell(4, 8)), false)
})

test('uses the projected cell center', () => {
  assert.deepEqual(cellCenter(manifest.transform, 4, 5), { x: 27.5, y: -22.5 })
})
