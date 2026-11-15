import { cellCenter } from '../terrain/package.ts'
import type { Cell, Metrics } from './planner.ts'
import { FieldDStar, type FieldPoint } from './field-dstar.ts'
import { checkCrewSegment, fieldCosts, nativeHeight, type CrewTerrain } from './crew-terrain.ts'

export type CrewPolicy='distance'|'terrain'
export type CrewPoint=FieldPoint & {eastM:number;northM:number;elevationM:number;index:number;surfaceSlopeDeg:number;nativeSupportIndices:number[];cumulativeDistanceM:number;cumulativeHorizontalDistanceM:number;segmentGradeDeg:number;edgeSurfaceSlopeDeg:number}
export type CrewLeg={points:CrewPoint[];metrics:Metrics}
export type CrewRoute={status:'ok';datasetVersion:string;policy:CrewPolicy;engine:'field-dstar-crew-local-1';start:Cell;target:Cell;outbound:CrewLeg;returnLeg:CrewLeg;metrics:Metrics;scienceWaypointIndex:number;turnaroundDistanceM:number;expandedCells:number;localSteps:number;rejectedCandidates:number}

export function crewLeg(terrain:CrewTerrain,path:FieldPoint[],policy:CrewPolicy):CrewLeg {
  const metrics:Metrics={distanceM:0,horizontalDistanceM:0,positiveClimbM:0,maxSurfaceSlopeDeg:0,maxAbsGradeDeg:0,warningEdgeCount:0,cost:0,estimatedTimeS:null},points:CrewPoint[]=[]
  function point(p:FieldPoint,grade:number,edgeSlope:number) {
    const value=nativeHeight(terrain,p)
    if(!value)throw new Error('Unknown native support on final route')
    const xy=cellCenter(terrain.grid.transform,p.row,p.column),index=Math.floor(p.row+.5)*terrain.grid.columns+Math.floor(p.column+.5)
    points.push({...p,eastM:xy.x,northM:xy.y,elevationM:value.elevationM,index,surfaceSlopeDeg:terrain.grid.slope[index],nativeSupportIndices:value.supportIndices,cumulativeDistanceM:metrics.distanceM,cumulativeHorizontalDistanceM:metrics.horizontalDistanceM,segmentGradeDeg:grade,edgeSurfaceSlopeDeg:edgeSlope})
  }
  point(path[0],0,terrain.grid.slope[Math.round(path[0].row)*terrain.grid.columns+Math.round(path[0].column)])
  metrics.maxSurfaceSlopeDeg=points[0].surfaceSlopeDeg
  for(let i=1;i<path.length;i++) {
    const step=checkCrewSegment(terrain,path[i-1],path[i]);if(!step)throw new Error('Final crew segment failed native/clearance validation')
    let prior=path[i-1]
    for(const part of step.parts) {
      if(part.horizontalM<1e-8)continue
      const checked=checkCrewSegment(terrain,prior,part.point);if(!checked)throw new Error('Native piece failed validation')
      metrics.distanceM+=part.distanceM;metrics.horizontalDistanceM+=part.horizontalM;metrics.positiveClimbM+=Math.max(0,part.elevationM-points[points.length-1].elevationM)
      metrics.maxSurfaceSlopeDeg=Math.max(metrics.maxSurfaceSlopeDeg,checked.maxSurfaceSlopeDeg);metrics.maxAbsGradeDeg=Math.max(metrics.maxAbsGradeDeg,Math.abs(part.gradeDeg))
      metrics.cost+=policy==='distance'?part.horizontalM:checked.terrainCost
      if(checked.maxSurfaceSlopeDeg>terrain.rules.warningSlopeDeg)metrics.warningEdgeCount++
      point(part.point,part.gradeDeg,checked.maxSurfaceSlopeDeg);prior=part.point
    }
  }
  return {points,metrics}
}

export function planCrewRoute(terrain:CrewTerrain,start:Cell,target:Cell,policy:CrewPolicy,options={stepM:1,directions:32,turnWeight:.05,maxSteps:5000}):CrewRoute {
  for(const p of [start,target])if(!Number.isInteger(p.row)||!Number.isInteger(p.column)||p.row<0||p.column<0||p.row>=terrain.grid.rows||p.column>=terrain.grid.columns)throw new Error('outside_coverage: crew endpoint is outside native grid')
  if(terrain.blocked[start.row*terrain.grid.columns+start.column])throw new Error('blocked_start: crew clearance or traversability failure')
  if(terrain.blocked[target.row*terrain.grid.columns+target.column])throw new Error('blocked_goal: crew clearance or traversability failure')
  if(!Number.isFinite(options.stepM)||options.stepM<=0||!Number.isInteger(options.directions)||options.directions<8||!Number.isFinite(options.turnWeight)||options.turnWeight<0||!Number.isInteger(options.maxSteps)||options.maxSteps<1)throw new Error('Invalid crew local planning configuration')
  const costs=fieldCosts(terrain,policy),field=new FieldDStar(terrain.grid.rows,terrain.grid.columns,terrain.spacingM,costs,target)
  field.compute()
  if(!Number.isFinite(field.g[start.row*terrain.grid.columns+start.column]))throw new Error('no_route: Field D* found no connected crew corridor')
  const path:FieldPoint[]=[{...start}];let p:FieldPoint={...start},heading=Math.atan2(target.row-start.row,target.column-start.column),localSteps=0,rejectedCandidates=0
  while(Math.hypot(p.row-target.row,p.column-target.column)>1e-8) {
    if(++localSteps>options.maxSteps)throw new Error('no_route: local step budget exceeded')
    const current=field.query(p).cost,remaining=terrain.spacingM*Math.hypot(p.row-target.row,p.column-target.column)
    const successor=field.nodeSuccessor(Math.round(p.row),Math.round(p.column))
    const angles=[Math.atan2(target.row-p.row,target.column-p.column),Math.atan2(successor.row-p.row,successor.column-p.column)]
    for(let k=0;k<options.directions;k++)angles.push(2*Math.PI*k/options.directions)
    let best:{point:FieldPoint;heading:number;score:number}|undefined
    for(const length of [Math.min(options.stepM,remaining),Math.min(options.stepM/2,remaining)])for(const angle of angles) {
      const q=length>=remaining-1e-9&&angle===angles[0]?{...target}:{row:p.row+Math.sin(angle)*length/terrain.spacingM,column:p.column+Math.cos(angle)*length/terrain.spacingM}
      const checked=checkCrewSegment(terrain,p,q)
      if(!checked){rejectedCandidates++;continue}
      const tail=field.query(q).cost
      if(!Number.isFinite(tail)||tail>=current-length*.01){rejectedCandidates++;continue}
      const turn=Math.abs(Math.atan2(Math.sin(angle-heading),Math.cos(angle-heading)))
      const local=policy==='distance'?checked.horizontalDistanceM:checked.terrainCost
      const score=local+tail+options.turnWeight*turn
      if(!best||score<best.score)best={point:q,heading:angle,score}
    }
    if(!best)throw new Error(`no_route: local candidate checks stalled at row ${p.row}, column ${p.column}; no A* fallback or limit relaxation`)
    p=best.point;heading=best.heading;path.push(p)
  }
  const outbound=crewLeg(terrain,path,policy)
  // Native breakpoints are retained, and all checks are repeated in reverse.
  const returnLeg=crewLeg(terrain,[...outbound.points].reverse(),policy),a=outbound.metrics,b=returnLeg.metrics
  const metrics:Metrics={distanceM:a.distanceM+b.distanceM,horizontalDistanceM:a.horizontalDistanceM+b.horizontalDistanceM,positiveClimbM:a.positiveClimbM+b.positiveClimbM,maxSurfaceSlopeDeg:Math.max(a.maxSurfaceSlopeDeg,b.maxSurfaceSlopeDeg),maxAbsGradeDeg:Math.max(a.maxAbsGradeDeg,b.maxAbsGradeDeg),warningEdgeCount:a.warningEdgeCount+b.warningEdgeCount,cost:a.cost+b.cost,estimatedTimeS:null}
  return {status:'ok',datasetVersion:terrain.grid.datasetVersion,policy,engine:'field-dstar-crew-local-1',start,target,outbound,returnLeg,metrics,scienceWaypointIndex:outbound.points.length-1,turnaroundDistanceM:a.distanceM,expandedCells:field.processed,localSteps,rejectedCandidates}
}
