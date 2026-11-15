import {worldToPixel,cellCenter} from '../terrain/package.ts'
import {assessCrewTerrain,checkCrewSegment,type CrewTerrain} from './crew-terrain.ts'
import {planCrewRoute,crewLeg,type CrewPoint,type CrewLeg,type CrewRoute} from './crew-planner.ts'
import {profilePoints,createProfileSampler,type ProfilePoint} from './profile.ts'
import type {Cell,Grid,Metrics} from './planner.ts'
import type {PlanningConfig} from './interactive.ts'
import type {MissionRoute} from '../mission/conditions.ts'

export type Incident={id:number;kind:'obstacle'|'gap';eastM:number;northM:number;radiusM:number;reportedAtDistanceM?:number}
export type IncidentRoute=CrewRoute & MissionRoute
export type IncidentRequest={id:number;grid:Grid;config:PlanningConfig;route:MissionRoute;distanceM:number;incidents:Incident[];gradeCapDeg:number}
export type IncidentChoice={kind:'science'|'return';route?:IncidentRoute;error?:string}
export type IncidentMessage={id:number;type:'progress';text:string}|{id:number;type:'result';choices:IncidentChoice[]}|{id:number;type:'error';text:string}
export function incidentContains(incident:Incident,p:{eastM:number;northM:number},margin=0){return Math.hypot(p.eastM-incident.eastM,p.northM-incident.northM)<=incident.radiusM+margin}
export function segmentTouchesIncident(a:{eastM:number;northM:number},b:{eastM:number;northM:number},incident:Incident){
  const dx=b.eastM-a.eastM,dy=b.northM-a.northM,length2=dx*dx+dy*dy
  const t=length2?Math.max(0,Math.min(1,((incident.eastM-a.eastM)*dx+(incident.northM-a.northM)*dy)/length2)):0
  return incidentContains(incident,{eastM:a.eastM+t*dx,northM:a.northM+t*dy})
}
export function withIncidents(grid:Grid,incidents:Incident[]):Grid{
  const coverage=grid.coverage.slice(),exclusions=grid.exclusions.slice(),spacing=grid.transform[1]
  for(const incident of incidents){
    if(!Number.isFinite(incident.radiusM)||incident.radiusM<=0||incident.radiusM>50||![incident.eastM,incident.northM].every(Number.isFinite))throw new Error('Invalid simulated incident.')
    const pixel=worldToPixel(grid.transform,incident.eastM,incident.northM),radius=(incident.radiusM+spacing*Math.SQRT2/2)/spacing
    for(let r=Math.max(0,Math.floor(pixel.row-radius));r<=Math.min(grid.rows-1,Math.ceil(pixel.row+radius));r++)for(let c=Math.max(0,Math.floor(pixel.column-radius));c<=Math.min(grid.columns-1,Math.ceil(pixel.column+radius));c++){
      // Conservatively mask every touched cell box, including the circular boundary.
      if(Math.hypot(r-pixel.row,c-pixel.column)<=radius){const i=r*grid.columns+c;if(incident.kind==='gap')coverage[i]=0;else exclusions[i]=1}
    }
  }
  return {...grid,coverage,exclusions}
}
function fieldPoint(grid:Grid,p:ProfilePoint){
  // Retain native coordinates when available. Reprojecting kilometre-scale
  // northings can create tiny spurious pieces at triangle boundaries.
  const native=p as ProfilePoint & {row?:number;column?:number}
  if(Number.isFinite(native.row)&&Number.isFinite(native.column)){
    const xy=cellCenter(grid.transform,native.row!,native.column!)
    if(Math.hypot(xy.x-p.eastM,xy.y-p.northM)<1e-8)return {row:native.row!,column:native.column!}
  }
  return worldToPixel(grid.transform,p.eastM,p.northM)
}
function checkedLeg(terrain:CrewTerrain,start:{row:number;column:number},goal:Cell,config:PlanningConfig):CrewLeg{
  if(Math.hypot(start.row-goal.row,start.column-goal.column)<1e-8)return crewLeg(terrain,[start],'distance')
  if(checkCrewSegment(terrain,start,goal))return crewLeg(terrain,[start,goal],'distance')
  const seeds:Cell[]=[]
  for(let dr=-2;dr<=2;dr++)for(let dc=-2;dc<=2;dc++)seeds.push({row:Math.round(start.row)+dr,column:Math.round(start.column)+dc})
  seeds.sort((a,b)=>Math.hypot(a.row-start.row,a.column-start.column)-Math.hypot(b.row-start.row,b.column-start.column))
  let last='No checked connection from the current position to a native cell.'
  for(const seed of seeds){
    if(!checkCrewSegment(terrain,start,seed))continue
    try{const route=planCrewRoute(terrain,seed,goal,'distance',config.localPlanner);return crewLeg(terrain,[start,...route.outbound.points],'distance')}catch(e){last=e instanceof Error?e.message:last}
    // One reachable field seed suffices. Avoid repeating a full million-cell search on local-stall failures.
    break
  }
  throw new Error(last)
}
function join(points:ProfilePoint[]):CrewLeg{
  const metrics:Metrics={distanceM:0,horizontalDistanceM:0,positiveClimbM:0,maxSurfaceSlopeDeg:0,maxAbsGradeDeg:0,warningEdgeCount:0,cost:0,estimatedTimeS:null}
  const result:CrewPoint[]=[]
  for(const p of points){
    const a=result.at(-1)
    if(a){const h=Math.hypot(p.eastM-a.eastM,p.northM-a.northM),dz=p.elevationM-a.elevationM;if(h<1e-9&&Math.abs(dz)<1e-9)continue;metrics.distanceM+=Math.hypot(h,dz);metrics.horizontalDistanceM+=h;metrics.positiveClimbM+=Math.max(0,dz);metrics.maxAbsGradeDeg=Math.max(metrics.maxAbsGradeDeg,Math.abs(p.segmentGradeDeg))}
    metrics.maxSurfaceSlopeDeg=Math.max(metrics.maxSurfaceSlopeDeg,p.edgeSurfaceSlopeDeg)
    result.push({...p,cumulativeDistanceM:metrics.distanceM,cumulativeHorizontalDistanceM:metrics.horizontalDistanceM} as CrewPoint)
  }
  metrics.cost=metrics.horizontalDistanceM
  return {points:result,metrics}
}
export function computeIncidentChoices(request:IncidentRequest,progress:(text:string)=>void=()=>{}):IncidentChoice[]{
  const {grid,config,route,distanceM,incidents,gradeCapDeg}=request
  if(!Number.isFinite(distanceM)||distanceM<0||distanceM>route.metrics.distanceM||!Number.isFinite(gradeCapDeg)||gradeCapDeg<=0||gradeCapDeg>config.rules.moveGradeLimitDeg)throw new Error('Invalid incident request limits.')
  progress('Applying simulated obstacles and unknown coverage; checking native crew clearance…')
  const modified=withIncidents(grid,incidents),terrain=assessCrewTerrain(modified,{...config.rules,moveGradeLimitDeg:gradeCapDeg},config.crewModel)
  const current=createProfileSampler(route,config.rules.warningSlopeDeg)(distanceM),start=fieldPoint(grid,current)
  const original=profilePoints(route),prefix=original.filter(p=>p.cumulativeDistanceM<distanceM-1e-8)
  prefix.push(current)
  const home=fieldPoint(grid,original[0]),rover={row:Math.round(home.row),column:Math.round(home.column)}
  const pastScience=route.scienceStop!==false&&distanceM>=route.turnaroundDistanceM-1e-7
  const choices:IncidentChoice[]=[]
  for(const kind of ['science','return'] as const){
    if(kind==='science'&&pastScience){choices.push({kind,error:'The science stop has already been reached. Continue the return.'});continue}
    try{
      progress(kind==='science'?'Checking a detour to science and a separate return to the rover…':'Checking a return from the current position to the rover…')
      let out:CrewLeg,back:CrewLeg,turn:number
      if(kind==='science'){
        const toScience=checkedLeg(terrain,start,config.approach.cell,config),toRover=checkedLeg(terrain,config.approach.cell,rover,config)
        out=join([...prefix,...toScience.points]);back=join(toRover.points);turn=out.metrics.distanceM
      }else{
        const toRover=checkedLeg(terrain,start,rover,config)
        if(pastScience){
          out=join(original.filter(p=>p.cumulativeDistanceM<=route.turnaroundDistanceM+1e-8));turn=out.metrics.distanceM
          back=join([...original.filter(p=>p.cumulativeDistanceM>=route.turnaroundDistanceM-1e-8&&p.cumulativeDistanceM<distanceM-1e-8),current,...toRover.points])
        }else{out=join(prefix);back=join([current,...toRover.points]);turn=out.metrics.distanceM}
      }
      for(const leg of [out,back])leg.metrics.warningEdgeCount=leg.points.slice(1).filter(p=>p.edgeSurfaceSlopeDeg>config.rules.warningSlopeDeg).length
      const a=out.metrics,b=back.metrics,metrics={...a,distanceM:a.distanceM+b.distanceM,horizontalDistanceM:a.horizontalDistanceM+b.horizontalDistanceM,positiveClimbM:a.positiveClimbM+b.positiveClimbM,maxSurfaceSlopeDeg:Math.max(a.maxSurfaceSlopeDeg,b.maxSurfaceSlopeDeg),maxAbsGradeDeg:Math.max(a.maxAbsGradeDeg,b.maxAbsGradeDeg),cost:a.cost+b.cost,warningEdgeCount:a.warningEdgeCount+b.warningEdgeCount}
      const result:IncidentRoute={status:'ok',datasetVersion:grid.datasetVersion,engine:'field-dstar-crew-local-1',policy:'distance',start:{row:Math.round(home.row),column:Math.round(home.column)},target:config.approach.cell,outbound:out,returnLeg:back,metrics,scienceWaypointIndex:out.points.length-1,turnaroundDistanceM:turn,expandedCells:0,localSteps:0,rejectedCandidates:0,scienceStop:kind==='science'||pastScience,scienceMinutes:kind==='return'&&!pastScience?0:route.scienceMinutes,samplingSpentMinutes:route.samplingSpentMinutes,completedDistanceM:distanceM,name:kind==='science'?'Detour to science':'Return to rover'}
      // Every future native piece is checked again; completed history is retained rather than reclassified as new travel.
      const future=profilePoints(result).filter(p=>p.cumulativeDistanceM>distanceM+1e-7)
      let prior:ProfilePoint=current
      for(const p of future){if(!checkCrewSegment(terrain,fieldPoint(grid,prior),fieldPoint(grid,p)))throw new Error(`Future route failed native check at ${p.cumulativeDistanceM.toFixed(6)} m (${fieldPoint(grid,prior).row}, ${fieldPoint(grid,prior).column}) → (${fieldPoint(grid,p).row}, ${fieldPoint(grid,p).column}).`);prior=p}
      const end=result.returnLeg.points.at(-1)!,first=original[0]
      if(Math.hypot(end.eastM-first.eastM,end.northM-first.northM)>1e-6)throw new Error('Incident route does not end at the original rover.')
      choices.push({kind,route:result})
    }catch(error){choices.push({kind,error:error instanceof Error?error.message:'No checked route found.'})}
  }
  return choices
}
