// Verify a connected path on the synthetic grid before introducing a routing cost model.
export function hasConnectedPath(
  coverage: Uint8Array, exclusions: Uint8Array, columns: number, start: number, target: number,
): boolean {
  const traversable = (cell: number) => coverage[cell] === 1 && exclusions[cell] === 0
  if (!traversable(start) || !traversable(target)) return false

  const visited = new Set([start])
  const queue = [start]
  for (let position = 0; position < queue.length; position++) {
    const cell = queue[position]
    if (cell === target) return true
    const neighbours = [cell - columns, cell + columns]
    if (cell % columns > 0) neighbours.push(cell - 1)
    if (cell % columns < columns - 1) neighbours.push(cell + 1)
    for (const next of neighbours) {
      if (!visited.has(next) && traversable(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return false
}
