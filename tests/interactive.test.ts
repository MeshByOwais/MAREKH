import {test,expect} from 'bun:test'
import {computeLivePlan,validateFootprint,PlanningGeneration,type PlanningConfig} from '../src/routing/interactive.ts'
import {sampleProfile,profilePoints,slopeAlerts} from '../src/routing/profile.ts'
import type {Grid} from '../src/routing/planner.ts'

function fixture() {
  const grid:Grid={datasetVersion:'interactive-fixture',rows:40,columns:40,transform:[0,1,0,0,0,-1],elevation:new Float32Array(1600),slope:new Float32Array(1600),coverage:new Uint8Array(1600).fill(1),exclusions:new Uint8Array(1600)}
  const config:PlanningConfig={datasetVersion:grid.datasetVersion,rules:{warningSlopeDeg:10,routeSlopeLimitDeg:20,stagingSlopeLimitDeg:5,moveGradeLimitDeg:20,gentleWeight:4},crewModel:{bodyRadiusM:.45,clearanceMarginM:.55,roughnessRmsLimitM:.1,residualLimitM:.25,roughnessWeight:2},localPlanner:{stepM:1,directions:32,turnWeight:.05,maxSteps:5000},staging:{cell:{row:10,column:10},footprintWidthM:10,footprintHeightM:10},approach:{cell:{row:27,column:28},footprintWidthM:2,footprintHeightM:2}}
  return {grid,config}
}
test('staging validates its full footprint, including exact closed-box boundary contacts',()=>{
  const {grid}=fixture(),cell={row:10,column:10}
  const p=validateFootprint(grid,cell,10,10,5);expect(p.cellCount).toBe(121)
  grid.slope[5*40+5]=5.01
  expect(()=>validateFootprint(grid,cell,10,10,5)).toThrow('exceeds')
  grid.slope[5*40+5]=5
  expect(validateFootprint(grid,cell,10,10,5).maxSlopeDeg).toBe(5)
  // Width 9 touches cells exactly at ±5, so a corner exclusion still fails.
  grid.exclusions[5*40+5]=1
  expect(()=>validateFootprint(grid,cell,9,9,5)).toThrow('exclusion')
})
test('unknown, invalid and boundary staging are rejected without snapping',()=>{
  const {grid}=fixture()
  for(const cell of [{row:-1,column:10},{row:0,column:10},{row:10.1,column:10},{row:NaN,column:10}])expect(()=>validateFootprint(grid,cell,10,10,5)).toThrow()
  grid.coverage[8*40+8]=0
  expect(()=>validateFootprint(grid,{row:10,column:10},10,10,5)).toThrow('Unknown')
})
test('both live engines replan both policies, preserve endpoints and close both legs',()=>{
  const {grid,config}=fixture()
  for(const mode of ['crew','baseline'] as const){
    const original=computeLivePlan({id:1,grid,config,mode,start:{row:10,column:10}})
    const moved=computeLivePlan({id:2,grid,config,mode,start:{row:11,column:12}})
    expect(moved.routes.length).toBe(2);expect(moved.checkedPieces).toBeGreaterThan(0)
    for(let i=0;i<2;i++){
      const a=original.routes[i],b=moved.routes[i]
      expect(b.metrics.distanceM).not.toBe(a.metrics.distanceM)
      expect(b.outbound.points[0].row).toBe(11)
      expect(b.outbound.points.at(-1)!.row).toBe(config.approach.cell.row)
      expect(b.returnLeg.points.at(-1)!.eastM).toBeCloseTo(b.outbound.points[0].eastM,8)
      expect(b.metrics.estimatedTimeS).toBeNull()
    }
  }
})
test('a disconnected walk reports failure, rather than a partial replacement',()=>{
  const {grid,config}=fixture()
  for(let c=0;c<40;c++)grid.exclusions[20*40+c]=1
  for(const mode of ['crew','baseline'] as const)expect(()=>computeLivePlan({id:1,grid,config,mode,start:{row:10,column:10}})).toThrow('no_route')
  config.datasetVersion='wrong-source'
  expect(()=>computeLivePlan({id:2,grid,config,mode:'baseline',start:{row:10,column:10}})).toThrow('different terrain')
})
test('crew staging checks roughness across the whole square, beyond its centre',()=>{
  const {grid,config}=fixture();grid.elevation[5*40+5]=1
  expect(validateFootprint(grid,config.staging.cell,10,10,5).cellCount).toBe(121)
  expect(()=>computeLivePlan({id:1,grid,config,mode:'crew',start:config.staging.cell})).toThrow('footprint contains a roughness')
})
test('a new search, mode change or cancellation makes earlier messages stale',()=>{
  const generation=new PlanningGeneration(),first=generation.next(),second=generation.next()
  expect(generation.current(first)).toBe(false);expect(generation.current(second)).toBe(true)
  generation.next();expect(generation.current(second)).toBe(false)
})
const point=(x:number,d:number,grade:number,slope:number)=>({eastM:x,northM:0,elevationM:x,cumulativeDistanceM:d,segmentGradeDeg:grade,edgeSurfaceSlopeDeg:slope,surfaceSlopeDeg:0})
const route={outbound:{points:[point(0,0,0,0),point(10,15,8,12),point(20,30,7,5)]},returnLeg:{points:[point(20,0,0,0),point(10,15,-7,5),point(0,30,-8,12)]},turnaroundDistanceM:30,metrics:{distanceM:60}}
test('distance cursor interpolates both legs with signed return grade and correct segment alerts',()=>{
  const outbound=sampleProfile(route,7.5,10),back=sampleProfile(route,52.5,10)
  expect(outbound.eastM).toBe(5);expect(back.eastM).toBe(5)
  expect(outbound.leg).toBe('Outbound');expect(back.leg).toBe('Return')
  expect(outbound.segmentGradeDeg).toBe(8);expect(back.segmentGradeDeg).toBe(-8)
  expect(outbound.reasons).toEqual(back.reasons);expect(back.reasons.length).toBe(1)
  expect(sampleProfile(route,22.5,10).reasons).toEqual([])
  expect(sampleProfile(route,37.5,10).reasons).toEqual([])
  expect(sampleProfile(route,30,10).leg).toBe('Science turnaround')
  expect(sampleProfile(route,60,10).eastM).toBe(0)
  expect(profilePoints(route).at(-1)!.cumulativeDistanceM).toBe(60)
})
test('alert thresholds and unavailable readings agree with profile colouring',()=>{
  expect(slopeAlerts(10,10)).toEqual([]);expect(slopeAlerts(NaN,10)).toEqual([])
  expect(slopeAlerts(10.01,10).length).toBe(1)
  expect(sampleProfile(route,-100,10).distanceM).toBe(0)
  expect(sampleProfile(route,100,10).distanceM).toBe(60)
  expect(()=>sampleProfile(route,NaN,10)).toThrow()
})
