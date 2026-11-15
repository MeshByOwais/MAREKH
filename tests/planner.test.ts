import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { planRoute, edge, type Grid, type Rules, type Policy, type Route } from '../src/routing/planner.ts'
import { readFloatGrid } from '../src/terrain/package.ts'

const rules: Rules = { warningSlopeDeg: 10, routeSlopeLimitDeg: 20, stagingSlopeLimitDeg: 5, moveGradeLimitDeg: 20, gentleWeight: 4 }
function fixture(rows = 7, columns = 9): Grid {
  return { rows, columns, datasetVersion: 'analytic-test-1', transform: [0, 1, 0, 0, 0, -1], elevation: new Float32Array(rows*columns), slope: new Float32Array(rows*columns), coverage: new Uint8Array(rows*columns).fill(1), exclusions: new Uint8Array(rows*columns) }
}
function ok(value: ReturnType<typeof planRoute>): Route { expect(value.status).toBe('ok'); if (value.status !== 'ok') throw new Error(value.reason); return value }
function solve(g: Grid, policy: Policy = 'shortest') { return planRoute(g, rules, { row: 3, column: 0 }, { row: 3, column: 8 }, policy) }

// Deliberately simple reference: O(V²) Dijkstra and a separately written
// adjacency/grade/cost calculation, without the production heap or edge helper.
function reference(g: Grid, policy: Policy, start: number, goal: number): number {
  const n = g.rows*g.columns, d = Array(n).fill(Infinity), visited = new Set<number>(); d[start] = 0
  const valid = (i: number) => g.coverage[i] === 1 && g.exclusions[i] === 0 && Number.isFinite(g.elevation[i]) && Number.isFinite(g.slope[i]) && g.slope[i] >= 0 && g.slope[i] <= rules.routeSlopeLimitDeg
  const xy = (i: number) => { const row=Math.floor(i/g.columns),col=i%g.columns,t=g.transform; return [col*t[1]+row*t[2],col*t[4]+row*t[5]] }
  const h = (a: number,b: number) => Math.hypot(xy(a)[0]-xy(b)[0],xy(a)[1]-xy(b)[1])
  const gradeOK = (a: number,b: number) => Math.abs(Math.atan2(g.elevation[b]-g.elevation[a],h(a,b))*180/Math.PI) <= rules.moveGradeLimitDeg
  while (visited.size < n) {
    let a = -1
    for (let i=0;i<n;i++) if (!visited.has(i) && (a < 0 || d[i]<d[a])) a=i
    if (a < 0 || !Number.isFinite(d[a])) return Infinity
    if (a === goal) return d[a]
    visited.add(a)
    for (let b=0;b<n;b++) {
      const ar=Math.floor(a/g.columns),ac=a%g.columns,br=Math.floor(b/g.columns),bc=b%g.columns
      if (Math.max(Math.abs(ar-br),Math.abs(ac-bc))!==1 || !valid(a) || !valid(b) || !gradeOK(a,b)) continue
      const sides=ar!==br && ac!==bc ? [ar*g.columns+bc,br*g.columns+ac] : []
      if (sides.some(s=>!valid(s)||!gradeOK(a,s)||!gradeOK(b,s))) continue
      const maxSlope=Math.max(...[a,b,...sides].map(i=>g.slope[i])), length=Math.hypot(h(a,b),g.elevation[b]-g.elevation[a])
      const cost=length*(policy==='gentle'?1+rules.gentleWeight*(maxSlope/rules.routeSlopeLimitDeg)**2:1)
      d[b]=Math.min(d[b],d[a]+cost)
    }
  }
  return Infinity
}

test('flat grid matches analytical diagonal distance and reference optimum', () => {
  const g=fixture(),start={row:0,column:0},goal={row:6,column:8}
  for (const policy of ['shortest','gentle'] as const) {
    const r=ok(planRoute(g,rules,start,goal,policy))
    expect(r.outbound.metrics.distanceM).toBeCloseTo(6*Math.SQRT2+2,10)
    expect(r.outbound.metrics.cost).toBeCloseTo(reference(g,policy,0,62),10)
    expect(r.metrics.distanceM).toBeCloseTo(2*r.outbound.metrics.distanceM,10)
  }
})
test('steep surface barrier forces a detour and a complete barrier returns no_route', () => {
  const g=fixture(); for(let r=1;r<7;r++)g.slope[r*9+4]=25
  const path=ok(solve(g)); expect(path.outbound.points.some(p=>p.row===0)).toBe(true)
  expect(path.outbound.metrics.cost).toBeCloseTo(reference(g,'shortest',27,35),10)
  g.slope[4]=25; expect(solve(g).status).toBe('no_route')
})
test('gentle policy chooses the intentional longer, lower-slope detour', () => {
  const g=fixture(); for(let c=2;c<=6;c++)g.slope[3*9+c]=18
  const shortest=ok(solve(g)),gentle=ok(solve(g,'gentle'))
  expect(shortest.outbound.metrics.distanceM).toBe(8)
  expect(gentle.outbound.metrics.distanceM).toBeGreaterThan(8)
  expect(gentle.metrics.maxSurfaceSlopeDeg).toBeLessThan(shortest.metrics.maxSurfaceSlopeDeg)
  for(const r of [shortest,gentle])expect(r.outbound.metrics.cost).toBeCloseTo(reference(g,r.policy,27,35),10)
})
test('unknown cells and exclusions cannot be crossed by diagonal corner cutting', () => {
  const g=fixture(2,2); g.exclusions[1]=1; g.coverage[2]=0
  expect(planRoute(g,rules,{row:0,column:0},{row:1,column:1},'shortest').status).toBe('no_route')
  expect(edge(g,rules,0,3)).toBeUndefined()
})
test('diagonal side grades are checked at both ends, symmetrically', () => {
  const g=fixture(2,2);g.elevation[1]=1
  expect(edge(g,rules,0,3)).toBeUndefined();expect(edge(g,rules,3,0)).toBeUndefined()
  g.elevation[1]=0;g.elevation[3]=.5
  // Direct diagonal grade is below 20 degrees, cardinal side grade is above it.
  expect(Math.atan(.5/Math.SQRT2)*180/Math.PI).toBeLessThan(20)
  expect(edge(g,rules,0,3)).toBeUndefined();expect(edge(g,rules,3,0)).toBeUndefined()
})
test('steep along-move grades block travel independently of surface slope', () => {
  const g=fixture(1,3);g.elevation[1]=1
  expect(planRoute(g,rules,{row:0,column:0},{row:0,column:2},'shortest').status).toBe('no_route')
})
test('endpoint failures are explicit and there is no implicit grid snapping', () => {
  const g=fixture(),start={row:3,column:0},target={row:3,column:8}
  expect(planRoute(g,rules,{row:-1,column:0},target,'shortest').status).toBe('outside_coverage')
  expect(planRoute(g,rules,{row:3.1,column:0},target,'shortest').status).toBe('outside_coverage')
  g.coverage[27]=0;expect(solve(g).status).toBe('outside_coverage');g.coverage[27]=1
  g.exclusions[27]=1;expect(solve(g).status).toBe('blocked_start');g.exclusions[27]=0
  g.slope[35]=21;expect(solve(g).status).toBe('blocked_goal');g.slope[35]=NaN
  expect(planRoute(g,rules,start,target,'shortest').status).toBe('outside_coverage')
})
test('return reverses geometry and recomputes signed grades, climb and turnaround', () => {
  const g=fixture(1,4);g.elevation.set([0,.1,.05,.2])
  const r=ok(planRoute(g,rules,{row:0,column:0},{row:0,column:3},'shortest'))
  expect(r.returnLeg.points.map(p=>p.index)).toEqual([...r.outbound.points.map(p=>p.index)].reverse())
  expect(r.outbound.metrics.positiveClimbM).toBeCloseTo(.25,6);expect(r.returnLeg.metrics.positiveClimbM).toBeCloseTo(.05,6)
  expect(r.metrics.positiveClimbM).toBeCloseTo(.3,6)
  for(let i=1;i<4;i++)expect(r.returnLeg.points[i].segmentGradeDeg).toBeCloseTo(-r.outbound.points[4-i].segmentGradeDeg,10)
  expect(r.scienceWaypointIndex).toBe(3);expect(r.turnaroundDistanceM).toBe(r.outbound.metrics.distanceM);expect(r.metrics.estimatedTimeS).toBeNull()
})
test('same-cell mission is a well-defined zero-distance round trip', () => {
  const g=fixture();const r=ok(planRoute(g,rules,{row:2,column:2},{row:2,column:2},'gentle'))
  expect(r.metrics.distanceM).toBe(0);expect(r.scienceWaypointIndex).toBe(0);expect(r.returnLeg.points).toHaveLength(1)
})
test('invalid costs, arrays and transforms are rejected', () => {
  const g=fixture();expect(()=>planRoute(g,{...rules,gentleWeight:-1},{row:0,column:0},{row:1,column:1},'gentle')).toThrow()
  g.coverage=new Uint8Array(1);expect(()=>solve(g)).toThrow();const bad=fixture();bad.transform=[0,0,0,0,0,0];expect(()=>solve(bad)).toThrow()
})
test('A* agrees with independent Dijkstra on deterministic varied small grids', () => {
  let seed=719;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32}
  for(let n=0;n<20;n++) {
    const g=fixture(5,5);g.transform=[10,2,.2,20,.1,-1.5]
    for(let i=0;i<25;i++){g.elevation[i]=random()*.7;g.slope[i]=random()*25;g.exclusions[i]=random()<.12?1:0}
    for(const i of [0,24]){g.slope[i]=0;g.exclusions[i]=0}
    for(const policy of ['shortest','gentle'] as const){const expected=reference(g,policy,0,24),r=planRoute(g,rules,{row:0,column:0},{row:4,column:4},policy)
      if(Number.isFinite(expected))expect(ok(r).outbound.metrics.cost).toBeCloseTo(expected,9);else expect(r.status).toBe('no_route')
    }
  }
})
test('real-data results regenerate exactly and repeat deterministically', () => {
  const base=new URL('../public/sites/columbia-hills/',import.meta.url),read=(p:string)=>readFileSync(new URL(p,base))
  const m=JSON.parse(read('terrain-v1/manifest.json').toString()),config=JSON.parse(read('routes-v1/config.json').toString())
  const g:Grid={...m,elevation:readFloatGrid(read('terrain-v1/elevation.f32')),slope:readFloatGrid(read('terrain-v1/slope-deg.f32')),coverage:read('terrain-v1/coverage.u8'),exclusions:read('terrain-v1/exclusions.u8')}
  const saved=JSON.parse(read('routes-v1/routes.json').toString()).routes
  for(const policy of ['shortest','gentle'] as const){const result=planRoute(g,config.rules,config.staging.cell,config.approach.cell,policy);expect(result).toEqual(saved.find((r:Route)=>r.policy===policy));expect(planRoute(g,config.rules,config.staging.cell,config.approach.cell,policy)).toEqual(result)}
})
