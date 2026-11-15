export type TerrainManifest = {
  schemaVersion: number
  datasetVersion: string
  siteId: string
  provenance: string
  rows: number
  columns: number
  transform: [number, number, number, number, number, number]
  crsWkt: string
  units: { elevation: string; slope: string }
  storage: { order: string; floatByteOrder: string }
  assets: Record<string, { bytes: number; sha256: string }>
}

export type RealTerrainManifest = TerrainManifest & {
  schemaVersion: 2
  localOrigin: { eastM: number; northM: number; elevationM: number }
  boundsWSEN: [number, number, number, number]
  render: { stride: number; verticalScale: number }
  statistics: { validCells: number; cells: number; elevationMinM: number; elevationMaxM: number; slopeMinDeg: number; slopeMaxDeg: number }
  credits: string
}

export function worldToPixel(transform: TerrainManifest['transform'], east: number, north: number) {
  const [x, dx, sx, y, sy, dy] = transform
  const determinant = dx * dy - sx * sy
  if (!Number.isFinite(determinant) || determinant === 0) throw new Error('Terrain transform is not invertible')
  return {
    column: ((east - x) * dy - (north - y) * sx) / determinant - 0.5,
    row: ((north - y) * dx - (east - x) * sy) / determinant - 0.5,
  }
}

export function cellCenter(transform: TerrainManifest['transform'], row: number, column: number) {
  const [x, dx, shearX, y, shearY, dy] = transform
  return {
    x: x + (column + 0.5) * dx + (row + 0.5) * shearX,
    y: y + (column + 0.5) * shearY + (row + 0.5) * dy,
  }
}

export function readFloatGrid(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) throw new Error('Float grid byte count must be divisible by four')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Float32Array.from({ length: bytes.byteLength / 4 }, (_, index) => view.getFloat32(index * 4, true))
}
