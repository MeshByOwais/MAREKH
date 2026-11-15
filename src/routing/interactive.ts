import { cellCenter } from '../terrain/package.ts'
import { planRoute, edge, type Cell, type Grid, type Rules, type Route } from './planner.ts'
import { assessCrewTerrain, checkCrewSegment, type CrewModel } from './crew-terrain.ts'
import { planCrewRoute, type CrewRoute } from './crew-planner.ts'

export type LiveMode = 'crew' | 'baseline'
export type PlanningConfig = {
  datasetVersion: string; rules: Rules; crewModel: CrewModel
  localPlanner: { stepM: number; directions: number; turnWeight: number; maxSteps: number }
  staging: { cell: Cell; footprintWidthM: number; footprintHeightM: number }
  approach: { cell: Cell; footprintWidthM: number; footprintHeightM: number }
}
export type Footprint = { cell: Cell; eastM: number; northM: number; elevationM:number; cells: number[]; cellCount: number; maxSlopeDeg: number; slopeLimitDeg:number; boundsWSEN: number[]; geometry:{type:'Polygon';coordinates:number[][][]} }
export type LiveRequest = { id: number; grid: Grid; config: PlanningConfig; mode: LiveMode; start: Cell }
export type LivePlan = { routes: (Route | CrewRoute)[]; staging: Footprint; approach: Footprint; checkedPieces: number; mode: LiveMode }
export type LiveMessage = { id: number } & ({ type: 'progress'; text: string } | { type: 'result'; plan: LivePlan } | { type: 'error'; text: string })

/** Each new intent invalidates every earlier load/search, including failures. */
export class PlanningGeneration {
  private generation = 0
  next() { return ++this.generation }
  current(id: number) { return id === this.generation }
}

/** Closed cell boxes, including contact at the footprint boundary. */
export function validateFootprint(grid: Grid, cell: Cell, widthM: number, heightM: number, limitDeg: number): Footprint {
  const t = grid.transform
  if (t[2] || t[4] || t[1] <= 0 || t[5] >= 0) throw new Error('Unsupported footprint grid')
  if (![cell.row, cell.column].every(Number.isInteger) || cell.row < 0 || cell.column < 0 || cell.row >= grid.rows || cell.column >= grid.columns) throw new Error('Outside coverage: choose an integer row and column inside the map.')
  if (![widthM, heightM].every(v => Number.isFinite(v) && v > 0)) throw new Error('Invalid staging dimensions')
  const p = cellCenter(t, cell.row, cell.column), dx = t[1], dy = -t[5]
  const boundsWSEN = [p.x-widthM/2, p.y-heightM/2, p.x+widthM/2, p.y+heightM/2]
  // A touched cell centre is within half the footprint plus half a cell.
  const r0 = Math.ceil(cell.row-heightM/(2*dy)-.5-1e-9), r1 = Math.floor(cell.row+heightM/(2*dy)+.5+1e-9)
  const c0 = Math.ceil(cell.column-widthM/(2*dx)-.5-1e-9), c1 = Math.floor(cell.column+widthM/(2*dx)+.5+1e-9)
  if (r0 < 0 || c0 < 0 || r1 >= grid.rows || c1 >= grid.columns) throw new Error('Outside coverage: the complete staging footprint must fit inside known terrain.')
  let maxSlopeDeg = 0; const cells:number[]=[]
  for (let r=r0;r<=r1;r++) for (let c=c0;c<=c1;c++) {
    const i=r*grid.columns+c
    if (grid.coverage[i] !== 1 || !Number.isFinite(grid.elevation[i]) || !Number.isFinite(grid.slope[i]) || grid.slope[i] < 0) throw new Error(`Unknown terrain in footprint at ${r}, ${c}.`)
    if (grid.exclusions[i]) throw new Error(`Reviewed exclusion in footprint at ${r}, ${c}.`)
    if (grid.slope[i] > limitDeg) throw new Error(`Footprint slope ${grid.slope[i].toFixed(2)}° exceeds the ${limitDeg}° limit at ${r}, ${c}.`)
    maxSlopeDeg=Math.max(maxSlopeDeg,grid.slope[i]); cells.push(i)
  }
  const [w,s,e,n]=boundsWSEN
  return {cell:{...cell},eastM:p.x,northM:p.y,elevationM:grid.elevation[cell.row*grid.columns+cell.column],cells,cellCount:cells.length,maxSlopeDeg,slopeLimitDeg:limitDeg,boundsWSEN,geometry:{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}}
}

export function validateStagingCandidate(grid:Grid,config:PlanningConfig,cell:Cell,hazard?:Uint8Array) {
  const footprint=validateFootprint(grid,cell,config.staging.footprintWidthM,config.staging.footprintHeightM,config.rules.stagingSlopeLimitDeg)
  if(hazard&&footprint.cells.some(i=>hazard[i]))throw new Error('Staging footprint contains a roughness or other crew terrain hazard.')
  return footprint
}

/** Nearest passing native-cell footprint, not an automatic move or route guarantee. */
export function findNearbyStaging(grid:Grid,config:PlanningConfig,requested:Cell,hazard?:Uint8Array,maxDistanceM=100) {
  if(![requested.row,requested.column].every(Number.isInteger)||!Number.isFinite(maxDistanceM)||maxDistanceM<0)throw new Error('Choose a valid cell before finding nearby staging.')
  const {rows,columns,transform:t}=grid,dx=t[1],dy=-t[5]
  if(t[2]||t[4]||dx<=0||dy<=0)throw new Error('Unsupported footprint grid')
  if(hazard&&hazard.length!==rows*columns)throw new Error('Crew hazard dimensions do not match')
  // Integral counts let each complete staging square be checked in constant time.
  const stride=columns+1,prefix=new Uint32Array((rows+1)*stride)
  for(let r=0;r<rows;r++){
    let count=0
    for(let c=0;c<columns;c++){
      const i=r*columns+c
      if(grid.coverage[i]!==1||grid.exclusions[i]||!Number.isFinite(grid.elevation[i])||!Number.isFinite(grid.slope[i])||grid.slope[i]<0||grid.slope[i]>config.rules.stagingSlopeLimitDeg||hazard?.[i])count++
      prefix[(r+1)*stride+c+1]=prefix[r*stride+c+1]+count
    }
  }
  const halfRows=config.staging.footprintHeightM/(2*dy),halfCols=config.staging.footprintWidthM/(2*dx)
  const rLo=Math.ceil(-halfRows-.5-1e-9),rHi=Math.floor(halfRows+.5+1e-9),cLo=Math.ceil(-halfCols-.5-1e-9),cHi=Math.floor(halfCols+.5+1e-9)
  let best:Cell|undefined,bestSquared=maxDistanceM**2
  for(let r=Math.max(0,Math.ceil(requested.row-maxDistanceM/dy));r<=Math.min(rows-1,Math.floor(requested.row+maxDistanceM/dy));r++)for(let c=Math.max(0,Math.ceil(requested.column-maxDistanceM/dx));c<=Math.min(columns-1,Math.floor(requested.column+maxDistanceM/dx));c++){
    const squared=((r-requested.row)*dy)**2+((c-requested.column)*dx)**2
    if(squared>bestSquared||best&&squared===bestSquared)continue
    const a=r+rLo,b=r+rHi+1,w=c+cLo,e=c+cHi+1
    if(a<0||w<0||b>rows||e>columns)continue
    const bad=prefix[b*stride+e]-prefix[a*stride+e]-prefix[b*stride+w]+prefix[a*stride+w]
    if(bad===0){best={row:r,column:c};bestSquared=squared}
  }
  return best?{footprint:validateStagingCandidate(grid,config,best,hazard),displacementM:Math.sqrt(bestSquared)}:undefined
}

export function computeLivePlan(request: LiveRequest, progress: (text: string) => void = () => {}): LivePlan {
  const {grid,config,mode,start}=request
  if (grid.datasetVersion !== config.datasetVersion) throw new Error('Planning data and rules belong to different terrain versions.')
  if (mode !== 'crew' && mode !== 'baseline') throw new Error('Choose a supported live planning model.')
  progress('Checking the full staging and approach footprints…')
  const staging=validateFootprint(grid,start,config.staging.footprintWidthM,config.staging.footprintHeightM,config.rules.stagingSlopeLimitDeg)
  const approach=validateFootprint(grid,config.approach.cell,config.approach.footprintWidthM,config.approach.footprintHeightM,config.rules.routeSlopeLimitDeg)
  progress('Preparing native terrain, roughness and clearance…')
  const terrain=mode==='crew'?assessCrewTerrain(grid,config.rules,config.crewModel):undefined
  if(terrain)for(const [name,footprint]of [['Staging',staging],['Approach',approach]] as const) {
    if(footprint.cells.some(i=>terrain.hazard[i]))throw new Error(`${name} footprint contains a roughness or other crew terrain hazard.`)
  }
  const routes:(Route|CrewRoute)[]=[]
  for (const policy of mode==='crew'?['distance','terrain'] as const:['shortest','gentle'] as const) {
    progress(`Searching ${policy==='distance'||policy==='shortest'?'distance':'terrain'} priority · the map stays available…`)
    const route=terrain?planCrewRoute(terrain,start,config.approach.cell,policy as 'distance'|'terrain',config.localPlanner):planRoute(grid,config.rules,start,config.approach.cell,policy as 'shortest'|'gentle')
    if (route.status!=='ok') throw new Error(`${route.status}: ${route.reason}`)
    routes.push(route)
  }
  progress('Rechecking every piece on both legs…')
  let checkedPieces=0
  for(const route of routes) {
    for(const leg of [route.outbound,route.returnLeg]) for(let i=1;i<leg.points.length;i++) {
      const a=leg.points[i-1],b=leg.points[i]
      if(terrain?!checkCrewSegment(terrain,a,b):!edge(grid,config.rules,a.index,b.index)) throw new Error('Final route check failed; existing plan retained.')
      checkedPieces++
    }
    const first=route.outbound.points[0],last=route.returnLeg.points.at(-1)!,turn=route.outbound.points.at(-1)!,back=route.returnLeg.points[0]
    if(Math.hypot(first.eastM-last.eastM,first.northM-last.northM)>1e-6||Math.hypot(turn.eastM-back.eastM,turn.northM-back.northM)>1e-6) throw new Error('Round trip does not close.')
  }
  return {routes,staging,approach,checkedPieces,mode}
}
