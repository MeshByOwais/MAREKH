import {describe,test,expect} from 'bun:test'
import {averageAbsoluteGrade,validateContinuousOptions} from '../src/routing/continuous.ts'

describe('continuous route controls',()=>{
  test('round trip descent cannot cancel ascent and weighting uses actual length',()=>{
    const points=[{cumulativeDistanceM:0,segmentGradeDeg:0},{cumulativeDistanceM:10,segmentGradeDeg:8},{cumulativeDistanceM:40,segmentGradeDeg:-2}]
    expect(averageAbsoluteGrade([{points}])).toBe(3.5)
    expect(averageAbsoluteGrade([{points:[{cumulativeDistanceM:0,segmentGradeDeg:0}]}])).toBe(0)
  })
  test('rejects invalid limits',()=>{
    for(const objective of ['gentlest','shortest-peak'] as const)validateContinuousOptions({objective,roundTripBudgetM:500,gradeLimitDeg:3})
    for(const bad of [NaN,Infinity,0,1201])expect(()=>validateContinuousOptions({objective:'gentlest',roundTripBudgetM:bad,gradeLimitDeg:3})).toThrow()
    for(const bad of [NaN,-1,0,21])expect(()=>validateContinuousOptions({objective:'shortest-peak',roundTripBudgetM:500,gradeLimitDeg:bad})).toThrow()
  })
})
