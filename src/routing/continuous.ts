import type { Cell } from './planner.ts'

export type ContinuousOptions = {
  objective: 'gentlest' | 'shortest-peak'
  roundTripBudgetM: number
  gradeLimitDeg: number
}
export type ContinuousRequest = ContinuousOptions & { start: Cell }
export type ContinuousBounds = {
  gradeLowerDeg: number; gradeUpperDeg: number
  distanceLowerM: number; distanceUpperM: number
  exactOptimumClaimed: false; method: string; scope: string
}

export function validateContinuousOptions(options: ContinuousOptions) {
  if (!['gentlest','shortest-peak'].includes(options.objective)) throw new Error('Choose a supported route objective.')
  if (!Number.isFinite(options.roundTripBudgetM) || options.roundTripBudgetM < 10 || options.roundTripBudgetM > 1200) throw new Error('Total round-trip distance must be between 10 and 1200 m.')
  if (!Number.isFinite(options.gradeLimitDeg) || options.gradeLimitDeg < .05 || options.gradeLimitDeg > 20) throw new Error('Walking grade must be between 0.05° and 20°.')
}

/** 3D-distance-weighted absolute angle: descent cannot cancel ascent. */
export function averageAbsoluteGrade(legs: { points: { cumulativeDistanceM: number; segmentGradeDeg: number }[] }[]) {
  let weighted = 0, length = 0
  for (const leg of legs) for (let i = 1; i < leg.points.length; i++) {
    const d = leg.points[i].cumulativeDistanceM - leg.points[i-1].cumulativeDistanceM
    weighted += d * Math.abs(leg.points[i].segmentGradeDeg); length += d
  }
  return length ? weighted / length : 0
}
