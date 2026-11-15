import {test,expect} from 'bun:test'
import {defaultScenario,createTiming,createMissionSampler,validateScenario} from '../src/mission/conditions.ts'
import {RehearsalPlayback} from '../src/mission/rehearsal.ts'
import type {ProfileRoute} from '../src/routing/profile.ts'
const p=(x:number,d:number,grade=0)=>({eastM:x,northM:0,elevationM:0,cumulativeDistanceM:d,surfaceSlopeDeg:12,edgeSurfaceSlopeDeg:12,segmentGradeDeg:grade})
const route:ProfileRoute={outbound:{points:[p(0,0),p(60,60)]},returnLeg:{points:[p(60,0),p(0,60)]},turnaroundDistanceM:60,metrics:{distanceM:120}}
const scenario={...defaultScenario,walkingSpeedMS:1,gradePenalty:0,samplingMinutes:10,doseRateUSvH:60}
test('walking time, science time and dose use physical minutes, independently of playback speed',()=>{
  const {sample,timing}=createMissionSampler(route,scenario,10)
  expect(timing.walkingS).toBe(120);expect(timing.totalS).toBe(720)
  expect(sample(30).conditions.doseUSv).toBeCloseTo(.5,10)
  expect(sample(60).conditions.doseUSv).toBe(1);expect(sample(120).conditions.doseUSv).toBe(12)
  const slow=new RehearsalPlayback(120,60),fast=new RehearsalPlayback(120,60);slow.seek(30);fast.seek(30)
  expect(sample(slow.distanceM)).toEqual(sample(fast.distanceM))
})
test('all simultaneous reasons are retained and individual sensor kinds remain distinguishable',()=>{
  const {sample}=createMissionSampler(route,{...scenario,temperatureC:-100,spatialVariationC:0,diurnalVariationC:0,coldAlertC:-65,doseAlertUSv:1,missionBudgetMinutes:5,reserveMinutes:1},10)
  const s=sample(90)
  expect(s.conditions.alerts.map(a=>a.kind)).toEqual(['slope','temperature','radiation','budget']);expect(s.reasons.length).toBe(4)
})
test('missing environmental data trigger no cold or radiation alerts',()=>{
  const s=createMissionSampler(route,{...scenario,enabled:false},10).sample(120)
  expect(s.conditions.temperatureC).toBeNull();expect(s.conditions.pressurePa).toBeNull();expect(s.conditions.doseUSv).toBeNull()
  expect(s.conditions.alerts.map(a=>a.kind)).toEqual(['slope'])
})
test('return reserve and maximum sampling allowance follow route duration, including altered stops',()=>{
  const t=createTiming(route,{...scenario,missionBudgetMinutes:30,reserveMinutes:5})
  expect(t.availableSamplingMinutes).toBe(23);expect(t.latestScienceDepartureMinutes).toBe(24)
  const skipped=createTiming({...route,scienceStop:false,scienceMinutes:0},scenario);expect(skipped.totalS).toBe(120)
  const spent=createTiming({...route,scienceMinutes:15,completedDistanceM:90},scenario);expect(spent.totalS).toBe(1020);expect(spent.elapsedAt(90)).toBe(990)
})
test('sampling time already spent survives skipping the remaining planned stop',()=>{
  const t=createTiming({...route,scienceMinutes:0,samplingSpentMinutes:5},scenario)
  expect(t.elapsedAt(60)).toBe(360);expect(t.totalS).toBe(420);expect(t.elapsedAt(90)).toBe(390)
})
test('a return decision is not treated as an unvisited science stop',()=>{
  const p=new RehearsalPlayback(120,30,false);p.seek(25);p.play();p.advance(10,10);expect(p.distanceM).toBe(120);expect(p.stage).toBe('complete')
})
test('invalid scenario values never replace a valid time model',()=>{
  for(const change of [{walkingSpeedMS:0},{doseRateUSvH:NaN},{pressurePa:-1},{missionBudgetMinutes:10,reserveMinutes:10}])expect(()=>validateScenario({...scenario,...change})).toThrow()
})

test('a reported coverage gap explains red pieces and withholds terrain readings from that future position',()=>{
  const gap={id:1,kind:'gap' as const,eastM:30,northM:0,radiusM:5,reportedAtDistanceM:10}
  const s=createMissionSampler(route,scenario,10,[gap]).sample(30)
  expect(s.conditions.coverageUnavailable).toBe(true);expect(s.conditions.alerts.map(a=>a.kind)).toContain('coverage');expect(s.conditions.alerts.map(a=>a.kind)).not.toContain('slope')
  const history=createMissionSampler({...route,completedDistanceM:40},scenario,10,[gap]).sample(30)
  expect(history.conditions.coverageUnavailable).toBe(false)
})
