import { cellCenter, type RealTerrainManifest } from './package.ts'

export function buildSurface(manifest: RealTerrainManifest, height: Float32Array, coverage: Uint8Array, stride = manifest.render.stride) {
  const { rows, columns, localOrigin: origin } = manifest
  if (!Number.isInteger(stride) || stride < 1) throw new Error('Display stride must be a positive integer')
  if (height.length !== rows * columns || coverage.length !== height.length) throw new Error('Terrain grid dimensions do not match')
  const axis = (length: number) => {
    const values = Array.from({ length: Math.ceil((length - 1) / stride) }, (_, i) => i * stride)
    values.push(length - 1)
    return values
  }
  const rowSamples = axis(rows), columnSamples = axis(columns)
  const count = rowSamples.length * columnSamples.length
  const positions = new Float32Array(count * 3)
  const uv = new Float32Array(count * 2)
  const cells = new Uint32Array(count)
  const indices = new Uint32Array((rowSamples.length - 1) * (columnSamples.length - 1) * 6)
  const prefixColumns = columns + 1
  const unknown = new Uint32Array((rows + 1) * prefixColumns)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col
      const p = (row + 1) * prefixColumns + col + 1
      unknown[p] = (coverage[index] === 1 && Number.isFinite(height[index]) ? 0 : 1)
        + unknown[p - 1] + unknown[p - prefixColumns] - unknown[p - prefixColumns - 1]
    }
  }
  let next = 0
  for (let r = 0; r < rowSamples.length; r++) {
    for (let c = 0; c < columnSamples.length; c++) {
      const row = rowSamples[r], col = columnSamples[c]
      const cell = row * columns + col
      const vertex = r * columnSamples.length + c
      const point = cellCenter(manifest.transform, row, col)
      positions.set([point.x - origin.eastM, Number.isFinite(height[cell]) ? height[cell] - origin.elevationM : 0, -(point.y - origin.northM)], vertex * 3)
      uv.set([(col + 0.5) / columns, 1 - (row + 0.5) / rows], vertex * 2)
      cells[vertex] = cell
      if (r === rowSamples.length - 1 || c === columnSamples.length - 1) continue
      const bottom = rowSamples[r + 1] + 1, right = columnSamples[c + 1] + 1
      const missing = unknown[bottom * prefixColumns + right] - unknown[row * prefixColumns + right]
        - unknown[bottom * prefixColumns + col] + unknown[row * prefixColumns + col]
      if (missing !== 0) continue
      const below = vertex + columnSamples.length
      indices.set([vertex, below, vertex + 1, vertex + 1, below, below + 1], next)
      next += 6
    }
  }
  return { positions, uv, cells, indices: indices.slice(0, next), rowSamples, columnSamples }
}
