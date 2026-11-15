import {test,expect} from 'bun:test'
import {FieldDStar,interpolatedCost} from '../src/routing/field-dstar.ts'
import {assessCrewTerrain,fieldCosts,checkCrewSegment,nativeHeight,touchedCells,type CrewModel} from '../src/routing/crew-terrain.ts'
import {planCrewRoute} from '../src/routing/crew-planner.ts'
import type {Grid,Rules} from '../src/routing/planner.ts'

const rules:Rules={warningSlopeDeg:10,routeSlopeLimitDeg:20,stagingSlopeLimitDeg:5,moveGradeLimitDeg:20,gentleWeight:4}
const model:CrewModel={bodyRadiusM:.45,clearanceMarginM:.55,roughnessRmsLimitM:.1,residualLimitM:.25,roughnessWeight:2}
function grid(rows=25,columns=25):Grid {return {rows,columns,datasetVersion:'crew-fixture',transform:[0,1,0,0,0,-1],elevation:new Float32Array(rows*columns),slope:new Float32Array(rows*columns),coverage:new Uint8Array(rows*columns).fill(1),exclusions:new Uint8Array(rows*columns)}}

test('Field D* interpolation matches independent dense minimisation, including interior crossings',()=>{
  for(const c of [1,2,10])for(const a of [0,1,3,20])for(const b of [0,1,3,20]){
    let brute=Infinity
    for(let i=0;i<=10000;i++){const t=i/10000;brute=Math.min(brute,c*Math.sqrt(1+t*t)+(1-t)*a+t*b)}
    const actual=interpolatedCost(c,a,b)
    expect(actual.cost).toBeLessThanOrEqual(brute+1e-9);expect(actual.cost).toBeGreaterThan(brute-1e-6)
  }
  const p=interpolatedCost(2,1,0);expect(p.fraction).toBeCloseTo(1/Math.sqrt(3),12);expect(p.fraction).toBeGreaterThan(0);expect(p.fraction).toBeLessThan(1)
  expect(interpolatedCost(Infinity,1,2).cost).toBe(Infinity);expect(interpolatedCost(1,Infinity,2).cost).toBeCloseTo(2+Math.SQRT2,12)
})
test('Field D* produces an interpolated goal field within Euclidean/octile bounds on flat terrain',()=>{
  const f=new FieldDStar(8,9,2,new Float64Array(56).fill(1),{row:7,column:8});f.compute()
  for(let r=0;r<8;r++)for(let c=0;c<9;c++){
    const dr=7-r,dc=8-c,actual=f.g[r*9+c],euclid=2*Math.hypot(dr,dc),octile=2*(Math.min(dr,dc)*Math.SQRT2+Math.abs(dr-dc))
    expect(actual).toBeGreaterThanOrEqual(euclid-1e-9);expect(actual).toBeLessThanOrEqual(octile+1e-9)
    expect(f.g[r*9+c]).toBeCloseTo(f.rhs[r*9+c],8)
  }
  const child=f.nodeSuccessor(1,3);expect(!Number.isInteger(child.row)||!Number.isInteger(child.column)).toBe(true)
})
test('incremental cost increases, obstacles and removals match a fresh Field D* solve',()=>{
  const costs=new Float64Array(81).fill(1),goal={row:9,column:9},f=new FieldDStar(10,10,1,costs,goal);f.compute()
  for(const [r,c,value]of [[3,3,10],[4,4,Infinity],[5,4,Infinity],[3,3,1],[4,4,1],[5,4,1]]){
    f.updateCost(r,c,value);f.compute()
    const fresh=new FieldDStar(10,10,1,new Float64Array(costs),goal);fresh.compute()
    for(let i=0;i<100;i++)expect(f.g[i]).toBeCloseTo(fresh.g[i],8)
  }
})
test('a full barrier makes the Field D* start unreachable and repairs when a passage is restored',()=>{
  const f=new FieldDStar(8,8,1,new Float64Array(49).fill(1),{row:7,column:7});f.compute()
  for(let c=0;c<7;c++)f.updateCost(3,c,Infinity)
  f.compute();expect(f.g[0]).toBe(Infinity)
  f.updateCost(3,4,1);f.compute();expect(Number.isFinite(f.g[0])).toBe(true)
})
test('slope is removed before roughness is assessed, while a local bump creates a hazard',()=>{
  const g=grid();for(let r=0;r<25;r++)for(let c=0;c<25;c++)g.elevation[r*25+c]=-.1*r+.05*c
  let t=assessCrewTerrain(g,rules,model);expect(t.roughness[12*25+12]).toBeLessThan(1e-6);expect(t.blocked[12*25+12]).toBe(0)
  g.elevation[12*25+12]+=1;t=assessCrewTerrain(g,rules,model);expect(t.hazard[12*25+12]).toBe(1);expect(t.blocked[12*25+13]).toBe(1)
})
test('whole-cell configuration-space inflation includes exclusions, unknown data and map boundaries',()=>{
  const g=grid();g.exclusions[12*25+12]=1;g.coverage[6*25+6]=0
  const t=assessCrewTerrain(g,rules,model)
  expect(t.blocked[12*25+13]).toBe(1);expect(t.blocked[11*25+11]).toBe(1);expect(t.blocked[12*25+15]).toBe(0)
  expect(t.blocked[6*25+6]).toBe(1);expect(t.blocked[0]).toBe(1)
  expect(checkCrewSegment(t,{row:10,column:13},{row:14,column:13})).toBeUndefined()
})
test('continuous segment checks reject corner contact and excessive piecewise grade',()=>{
  const g=grid();g.exclusions[12*25+12]=1;const t=assessCrewTerrain(g,rules,model)
  expect(checkCrewSegment(t,{row:10,column:10},{row:14,column:14})).toBeUndefined()
  const plane=grid();for(let r=0;r<25;r++)for(let c=0;c<25;c++)plane.elevation[r*25+c]=c*.5
  const steep=assessCrewTerrain(plane,rules,model);expect(checkCrewSegment(steep,{row:10,column:10},{row:10,column:11})).toBeUndefined()
  expect(fieldCosts(steep,'distance')[10*24+10]).toBe(Infinity)
})
test('closed corner contact is symmetric on both floating-point sides of a split',()=>{
  const g=grid(),t=assessCrewTerrain(g,rules,model)
  g.slope[11*25+10]=15
  for(const delta of [-1e-13,0,1e-13]){
    const p={row:10.5+delta,column:10.5}
    expect(touchedCells(t,p)!.sort((a,b)=>a-b)).toEqual([260,261,285,286])
    expect(checkCrewSegment(t,{row:10.2,column:10.2},p)!.maxSurfaceSlopeDeg).toBe(15)
    t.blocked[11*25+10]=1
    expect(checkCrewSegment(t,{row:10.2,column:10.2},p)).toBeUndefined()
    t.blocked[11*25+10]=0
  }
})
test('native triangular interpolation has exact analytic heights and preserves missing support',()=>{
  const g=grid();for(let r=0;r<25;r++)for(let c=0;c<25;c++)g.elevation[r*25+c]=2*r+3*c
  const t=assessCrewTerrain(g,rules,model)
  expect(nativeHeight(t,{row:10.2,column:10.3})!.elevationM).toBeCloseTo(2*10.2+3*10.3,8)
  expect(nativeHeight(t,{row:10.8,column:10.7})!.elevationM).toBeCloseTo(2*10.8+3*10.7,8)
  g.coverage[10*25+10]=0;expect(nativeHeight(t,{row:10.2,column:10.3})).toBeUndefined()
})
test('local crew planning uses continuous headings, avoids hazards and closes its round trip',()=>{
  const t=assessCrewTerrain(grid(),rules,model),r=planCrewRoute(t,{row:5,column:5},{row:17,column:19},'distance')
  expect(r.outbound.points.some(p=>!Number.isInteger(p.row)&&!Number.isInteger(p.column))).toBe(true)
  // Local heading/turn ranking is heuristic; it need not reproduce a globally
  // exact straight line even when the goal field is unobstructed.
  expect(r.metrics.distanceM).toBeGreaterThanOrEqual(2*Math.hypot(12,14)-1e-9)
  expect(r.metrics.distanceM).toBeLessThan(2*(12*Math.SQRT2+2))
  expect(r.returnLeg.points.at(-1)!.eastM).toBe(r.outbound.points[0].eastM)
  expect(r.metrics.positiveClimbM).toBe(0);expect(r.metrics.estimatedTimeS).toBeNull()
})
test('crew endpoint footprint failures never relax limits or silently fall back',()=>{
  const g=grid();g.exclusions[5*25+6]=1;const t=assessCrewTerrain(g,rules,model)
  expect(()=>planCrewRoute(t,{row:5,column:5},{row:17,column:19},'distance')).toThrow('blocked_start')
  expect(()=>planCrewRoute(t,{row:-1,column:5},{row:17,column:19},'distance')).toThrow('outside_coverage')
})
test('global Field D* guidance gets local crew steps around an extended obstacle',()=>{
  const g=grid(45,45)
  for(let r=12;r<=30;r++)g.exclusions[r*45+22]=1
  const t=assessCrewTerrain(g,rules,model),route=planCrewRoute(t,{row:21,column:12},{row:21,column:32},'distance')
  expect(route.outbound.points.some(p=>p.row<10||p.row>32)).toBe(true)
  for(let i=1;i<route.outbound.points.length;i++)expect(checkCrewSegment(t,route.outbound.points[i-1],route.outbound.points[i])).toBeDefined()
  expect(route.returnLeg.points.at(-1)!.row).toBe(21)
})
