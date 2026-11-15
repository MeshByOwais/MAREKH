import {worldToPixel} from '../src/terrain/package.ts'
import {test,expect} from 'bun:test'
import {computeIncidentChoices,withIncidents,segmentTouchesIncident,type Incident} from '../src/routing/incidents.ts'
import {assessCrewTerrain,checkCrewSegment} from '../src/routing/crew-terrain.ts'
import {planCrewRoute} from '../src/routing/crew-planner.ts'
import {profilePoints,createProfileSampler} from '../src/routing/profile.ts'
import type {Grid} from '../src/routing/planner.ts'
import type {PlanningConfig} from '../src/routing/interactive.ts'
const grid:Grid={rows:60,columns:60,datasetVersion:'incident-fixture',transform:[0,1,0,0,0,-1],elevation:new Float32Array(3600),slope:new Float32Array(3600),coverage:new Uint8Array(3600).fill(1),exclusions:new Uint8Array(3600)}
const config:PlanningConfig={datasetVersion:grid.datasetVersion,rules:{warningSlopeDeg:10,routeSlopeLimitDeg:20,stagingSlopeLimitDeg:5,moveGradeLimitDeg:20,gentleWeight:4},crewModel:{bodyRadiusM:.45,clearanceMarginM:.55,roughnessRmsLimitM:.1,residualLimitM:.25,roughnessWeight:2},localPlanner:{stepM:1,directions:32,turnWeight:.05,maxSteps:5000},staging:{cell:{row:30,column:10},footprintWidthM:10,footprintHeightM:10},approach:{cell:{row:30,column:48},footprintWidthM:2,footprintHeightM:2}}
const terrain=assessCrewTerrain(grid,config.rules,config.crewModel),route=planCrewRoute(terrain,config.staging.cell,config.approach.cell,'distance')
test('incident cell masks preserve original data and block touched cells conservatively',()=>{
  const gap:Incident={id:1,kind:'gap',eastM:30.5,northM:-30.5,radiusM:4}
  const modified=withIncidents(grid,[gap]);expect(modified.coverage[30*60+30]).toBe(0);expect(grid.coverage[30*60+30]).toBe(1)
  const boulder=withIncidents(grid,[{...gap,kind:'obstacle'}]);expect(boulder.exclusions[30*60+30]).toBe(1);expect(boulder.coverage[30*60+30]).toBe(1)
  expect(segmentTouchesIncident({eastM:0,northM:-30.5},{eastM:60,northM:-30.5},gap)).toBe(true)
})
for(const kind of ['obstacle','gap'] as const)test(`${kind} detour preserves exact current position and completed travel, then ends at the original rover`,()=>{
  const incident:Incident={id:1,kind,eastM:30.5,northM:-30.5,radiusM:4},distance=7.3
  const choices=computeIncidentChoices({id:1,grid,config,route,distanceM:distance,incidents:[incident],gradeCapDeg:6})
  const modified=assessCrewTerrain(withIncidents(grid,[incident]),{...config.rules,moveGradeLimitDeg:6},config.crewModel)
  for(const choice of choices){
    expect(choice.error).toBeUndefined();expect(choice.route).toBeDefined();const r=choice.route!,points=profilePoints(r)
    expect(r.completedDistanceM).toBe(distance);expect(createProfileSampler(r,10)(distance).eastM).toBeCloseTo(createProfileSampler(route,10)(distance).eastM,8)
    expect(r.returnLeg.points.at(-1)!.eastM).toBe(route.outbound.points[0].eastM)
    for(let i=1;i<points.length;i++)if(points[i].cumulativeDistanceM>distance+1e-7){const a=worldToPixel(grid.transform,points[i-1].eastM,points[i-1].northM),b=worldToPixel(grid.transform,points[i].eastM,points[i].northM);expect(checkCrewSegment(modified,a,b)).toBeDefined()}
    if(choice.kind==='return'){expect(r.scienceStop).toBe(false);expect(r.scienceMinutes).toBe(0)}
  }
})
test('unknown start coverage fails explicitly rather than drawing a route through it',()=>{
  const gap:Incident={id:1,kind:'gap',eastM:17.8,northM:-30.5,radiusM:4}
  const choices=computeIncidentChoices({id:1,grid,config,route,distanceM:7.3,incidents:[gap],gradeCapDeg:6})
  expect(choices.every(c=>!!c.error&&!c.route)).toBe(true)
})
test('an incident on the return never offers to visit the science stop again',()=>{
  const choices=computeIncidentChoices({id:1,grid,config,route,distanceM:route.turnaroundDistanceM+5,incidents:[],gradeCapDeg:6})
  expect(choices[0].error).toContain('already');expect(choices[1].route).toBeDefined();expect(choices[1].route!.turnaroundDistanceM).toBeCloseTo(route.turnaroundDistanceM,8)
})

test('real native coordinates survive large-northing round trips near a grade-limited boundary',async()=>{
  const {readFile}=await import('node:fs/promises'),{readFloatGrid}=await import('../src/terrain/package.ts')
  const base=new URL('../public/sites/columbia-hills/',import.meta.url),json=async(p:string)=>JSON.parse(await readFile(new URL(p,base),'utf8'))
  const manifest=await json('terrain-v1/manifest.json'),realConfig=await json('crew-navigation-v1/config.json'),realRoute=(await json('global-grade-v1/routes.json')).routes[0]
  const bytes=async(n:string)=>new Uint8Array(await readFile(new URL('terrain-v1/'+n,base)))
  const realGrid={...manifest,elevation:readFloatGrid(await bytes('elevation.f32')),slope:readFloatGrid(await bytes('slope-deg.f32')),coverage:await bytes('coverage.u8'),exclusions:await bytes('exclusions.u8')}
  const distance=realRoute.metrics.distanceM/10,p=createProfileSampler(realRoute,10)(distance+20)
  const choices=computeIncidentChoices({id:1,grid:realGrid,config:realConfig,route:realRoute,distanceM:distance,incidents:[{id:1,kind:'obstacle',eastM:p.eastM,northM:p.northM,radiusM:6}],gradeCapDeg:6})
  expect(choices[1].route).toBeDefined();expect(choices[1].error).toBeUndefined()
  expect(choices[1].route!.metrics.maxAbsGradeDeg).toBeLessThanOrEqual(6)
})
