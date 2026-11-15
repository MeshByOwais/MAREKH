import type { Grid, Rules } from './planner.ts'
import type { FieldPoint } from './field-dstar.ts'

export type CrewModel = { bodyRadiusM: number; clearanceMarginM: number; roughnessRmsLimitM: number; residualLimitM: number; roughnessWeight: number }
export type CrewTerrain = { grid: Grid; rules: Rules; model: CrewModel; spacingM: number; roughness: Float32Array; residual: Float32Array; hazard: Uint8Array; blocked: Uint8Array; density: Float64Array }

export function assessCrewTerrain(grid: Grid,rules: Rules,model: CrewModel): CrewTerrain {
  const {rows,columns,elevation:z,slope,coverage,exclusions,transform:t}=grid,n=rows*columns
  if(t[2]!==0||t[4]!==0||t[1]<=0||t[5]>=0||Math.abs(t[1]+t[5])>1e-8)throw new Error('Crew terrain requires north-up square native cells')
  if([z,slope,coverage,exclusions].some(a=>a.length!==n))throw new Error('Crew grid size mismatch')
  if(![model.bodyRadiusM,model.clearanceMarginM,model.roughnessWeight].every(v=>Number.isFinite(v)&&v>=0)||![model.roughnessRmsLimitM,model.residualLimitM].every(v=>Number.isFinite(v)&&v>0))throw new Error('Invalid crew planning model')
  const roughness=new Float32Array(n).fill(NaN),residual=new Float32Array(n).fill(NaN),hazard=new Uint8Array(n).fill(1),blocked=new Uint8Array(n),density=new Float64Array(n).fill(Infinity)
  for(let r=1;r<rows-1;r++)for(let c=1;c<columns-1;c++) {
    const i=r*columns+c;let mean=0,gx=0,gy=0,valid=true
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++) {
      const j=(r+dr)*columns+c+dc,v=z[j]
      if(coverage[j]!==1||!Number.isFinite(v))valid=false
      mean+=v/9;gx+=dc*v/6;gy+=dr*v/6
    }
    if(!valid||coverage[i]!==1||!Number.isFinite(slope[i])||slope[i]<0)continue
    let square=0,max=0
    for(let dr=-1;dr<=1;dr++)for(let dc=-1;dc<=1;dc++) {
      const e=z[(r+dr)*columns+c+dc]-(mean+dc*gx+dr*gy);square+=e*e/9;max=Math.max(max,Math.abs(e))
    }
    roughness[i]=Math.sqrt(square);residual[i]=max
    hazard[i]=exclusions[i]!==0||slope[i]>rules.routeSlopeLimitDeg||roughness[i]>model.roughnessRmsLimitM||residual[i]>model.residualLimitM?1:0
  }
  const radius=model.bodyRadiusM+model.clearanceMarginM,reach=Math.ceil(radius/t[1])+1,offsets:number[][]=[]
  // Inflate from closed hazard cell boxes to whole candidate cell boxes. This
  // guarantees clearance throughout a traversed cell, not just at its centre.
  for(let dr=-reach;dr<=reach;dr++)for(let dc=-reach;dc<=reach;dc++)if(Math.hypot(Math.max(0,Math.abs(dr)-1)*t[1],Math.max(0,Math.abs(dc)-1)*t[1])<=radius)offsets.push([dr,dc])
  for(let r=0;r<rows;r++)for(let c=0;c<columns;c++) {
    const i=r*columns+c
    blocked[i]=offsets.some(([dr,dc])=>r+dr<0||c+dc<0||r+dr>=rows||c+dc>=columns||hazard[(r+dr)*columns+c+dc]!==0)?1:0
    if(!blocked[i])density[i]=1+rules.gentleWeight*(slope[i]/rules.routeSlopeLimitDeg)**2+model.roughnessWeight*(roughness[i]/model.roughnessRmsLimitM)**2
  }
  return {grid,rules,model,spacingM:t[1],roughness,residual,hazard,blocked,density}
}

export function fieldCosts(terrain: CrewTerrain,policy:'distance'|'terrain') {
  const {rows,columns,elevation:z}=terrain.grid,out=new Float64Array((rows-1)*(columns-1)).fill(Infinity),s=terrain.spacingM
  for(let r=0;r<rows-1;r++)for(let c=0;c<columns-1;c++) {
    const ids=[r*columns+c,r*columns+c+1,(r+1)*columns+c,(r+1)*columns+c+1]
    if(ids.some(i=>terrain.blocked[i]))continue
    // All triangular terrain gradients in the square must pass, so a local
    // step cannot exploit a diagonal with an acceptable average but steep parts.
    const [a,b,d,e]=ids.map(i=>z[i])
    const maxGradient=Math.max(Math.hypot(b-a,d-a),Math.hypot(e-d,e-b))/s
    if(Math.atan(maxGradient)*180/Math.PI>terrain.rules.moveGradeLimitDeg)continue
    out[r*(columns-1)+c]=policy==='distance'?1:Math.max(...ids.map(i=>terrain.density[i]))
  }
  return out
}

export function nativeHeight(terrain:CrewTerrain,p:FieldPoint) {
  const {rows,columns,elevation:z,coverage}=terrain.grid
  if(!Number.isFinite(p.row)||!Number.isFinite(p.column)||p.row<0||p.column<0||p.row>rows-1||p.column>columns-1)return undefined
  const r=Math.min(Math.floor(p.row),rows-2),c=Math.min(Math.floor(p.column),columns-2),y=p.row-r,x=p.column-c
  const ids=x+y<=1?[r*columns+c,r*columns+c+1,(r+1)*columns+c]:[(r+1)*columns+c+1,(r+1)*columns+c,r*columns+c+1]
  if(ids.some(i=>coverage[i]!==1||!Number.isFinite(z[i])))return undefined
  const value=x+y<=1?z[ids[0]]+x*(z[ids[1]]-z[ids[0]])+y*(z[ids[2]]-z[ids[0]]):z[ids[0]]+(1-x)*(z[ids[1]]-z[ids[0]])+(1-y)*(z[ids[2]]-z[ids[0]])
  return {elevationM:value,supportIndices:ids}
}

// Exact breakpoints at native cell boundaries, interpolation-patch boundaries,
// and patch diagonals. The model height is linear on every resulting piece.
export function segmentBreaks(a:FieldPoint,b:FieldPoint) {
  const values=[0,1],add=(start:number,end:number,step:number)=>{
    if(Math.abs(end-start)<1e-12)return
    for(let k=Math.ceil(Math.min(start,end)/step);k<=Math.floor(Math.max(start,end)/step);k++) {
      const t=(k*step-start)/(end-start);if(t>1e-10&&t<1-1e-10)values.push(t)
    }
  }
  add(a.row,b.row,.5);add(a.column,b.column,.5);add(a.row+a.column,b.row+b.column,1)
  return values.sort((x,y)=>x-y).filter((v,i,all)=>i===0||v-all[i-1]>1e-10)
}
export const mix=(a:FieldPoint,b:FieldPoint,t:number):FieldPoint=>({row:a.row+(b.row-a.row)*t,column:a.column+(b.column-a.column)*t})

export function touchedCells(terrain:CrewTerrain,p:FieldPoint) {
  const cols:number[]=[],rows:number[]=[]
  for(const [value,out] of [[p.row,rows],[p.column,cols]] as const) {
    const boundary=Math.round(value-.5)+.5
    // Treat either floating-point side of a closed cell boundary identically.
    // A split at 387.5 may be represented as 387.49999999999994.
    if(Math.abs(value-boundary)<1e-8)out.push(Math.floor(boundary),Math.floor(boundary)+1)
    else out.push(Math.floor(value+.5))
  }
  const ids:number[]=[]
  for(const r of rows)for(const c of cols) {
    if(r<0||c<0||r>=terrain.grid.rows||c>=terrain.grid.columns)return undefined
    ids.push(r*terrain.grid.columns+c)
  }
  return ids
}

export function checkCrewSegment(terrain:CrewTerrain,a:FieldPoint,b:FieldPoint) {
  const ts=segmentBreaks(a,b),crossed=new Set<number>(),support=new Set<number>()
  let distanceM=0,horizontalDistanceM=0,positiveClimbM=0,maxSurfaceSlopeDeg=0,maxAbsGradeDeg=0,terrainCost=0
  const parts:{point:FieldPoint;elevationM:number;gradeDeg:number;distanceM:number;horizontalM:number}[]=[]
  let prior=nativeHeight(terrain,a)
  if(!prior)return undefined
  for(let i=0;i<ts.length;i++) {
    const p=mix(a,b,ts[i]),cells=touchedCells(terrain,p)
    const middle=i?touchedCells(terrain,mix(a,b,(ts[i]+ts[i-1])/2)):[]
    if(!cells||!middle||[...cells,...middle].some(j=>terrain.blocked[j]))return undefined
    for(const j of [...cells,...middle]) {crossed.add(j);maxSurfaceSlopeDeg=Math.max(maxSurfaceSlopeDeg,terrain.grid.slope[j])}
    const value=nativeHeight(terrain,p)
    if(!value)return undefined
    for(const j of value.supportIndices)support.add(j)
    if(i) {
      const prev=mix(a,b,ts[i-1]),h=terrain.spacingM*Math.hypot(p.row-prev.row,p.column-prev.column),dz=value.elevationM-prior.elevationM
      const grade=Math.atan2(dz,h)*180/Math.PI,length=Math.hypot(h,dz)
      if(Math.abs(grade)>terrain.rules.moveGradeLimitDeg+1e-8)return undefined
      distanceM+=length;horizontalDistanceM+=h;positiveClimbM+=Math.max(0,dz);maxAbsGradeDeg=Math.max(maxAbsGradeDeg,Math.abs(grade))
      terrainCost+=h*Math.max(...middle.map(j=>terrain.density[j]));parts.push({point:p,elevationM:value.elevationM,gradeDeg:grade,distanceM:length,horizontalM:h})
    }
    prior=value
  }
  return {distanceM,horizontalDistanceM,positiveClimbM,maxSurfaceSlopeDeg,maxAbsGradeDeg,terrainCost,crossedCells:[...crossed].sort((a,b)=>a-b),supportIndices:[...support].sort((a,b)=>a-b),parts}
}
