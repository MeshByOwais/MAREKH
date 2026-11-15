// Both preflight and final packaging use the same pinned native crew checks.
import {createHash} from 'node:crypto'
import {readFile,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {readFloatGrid} from '../src/terrain/package.ts'
import {assessCrewTerrain} from '../src/routing/crew-terrain.ts'
import {crewLeg} from '../src/routing/crew-planner.ts'
import {validateStagingCandidate,validateFootprint} from '../src/routing/interactive.ts'
import {averageAbsoluteGrade,validateContinuousOptions,type ContinuousRequest} from '../src/routing/continuous.ts'

const root=resolve(import.meta.dir,'..'),work=resolve(process.argv[2])
const read=(p:string)=>readFile(p),json=async(p:string)=>JSON.parse(await read(p).then(b=>b.toString()))
const request:ContinuousRequest=await json(`${work}/request.json`);validateContinuousOptions(request)
const terrainRoot=`${root}/public/sites/columbia-hills/terrain-v1`,crewRoot=`${root}/public/sites/columbia-hills/crew-navigation-v1`
const m=await json(`${terrainRoot}/manifest.json`),cm=await json(`${crewRoot}/manifest.json`)
async function checked(base:string,manifest:typeof m,name:string){
  const b=await read(`${base}/${name}`),record=manifest.assets[name]
  if(b.length!==record.bytes||createHash('sha256').update(b).digest('hex')!==record.sha256)throw new Error(`Input hash mismatch: ${name}`)
  return b
}
const config=JSON.parse((await checked(crewRoot,cm,'config.json')).toString())
config.staging.cell=request.start
const arrays=await Promise.all(['elevation.f32','slope-deg.f32','coverage.u8','exclusions.u8'].map(n=>checked(terrainRoot,m,n)))
const grid={...m,elevation:readFloatGrid(arrays[0]),slope:readFloatGrid(arrays[1]),coverage:arrays[2],exclusions:arrays[3]}
const terrain=assessCrewTerrain(grid,config.rules,config.crewModel)
// Verify the persisted search mask against the actual runtime assessment.
const blocked=await checked(crewRoot,cm,'clearance-blocked.u8')
if(blocked.some((v,i)=>v!==terrain.blocked[i]))throw new Error('Crew search mask differs from native assessment')
const staging=validateStagingCandidate(grid,config,request.start,terrain.hazard)
const approach=validateFootprint(grid,config.approach.cell,config.approach.footprintWidthM,config.approach.footprintHeightM,config.rules.routeSlopeLimitDeg)
if(approach.cells.some(i=>terrain.hazard[i]))throw new Error('Approach footprint contains a crew hazard')
if(process.argv.includes('--prepare')){
  await writeFile(`${work}/prepared.json`,JSON.stringify({config,staging,approach}));process.exit(0)
}
const witness=await json(`${work}/witness.json`)
if(witness.needsGradeRealization||witness.points.length<2)throw new Error('No realizable continuous witness')
for(const [point,expected]of [[witness.points[0],request.start],[witness.points.at(-1),config.approach.cell]])if(point.row!==expected.row||point.column!==expected.column)throw new Error('Witness endpoints changed')
const outbound=crewLeg(terrain,witness.points,'distance'),returnLeg=crewLeg(terrain,[...outbound.points].reverse(),'distance')
const a=outbound.metrics,b=returnLeg.metrics
// Preserve distance-policy horizontal cost for the independent legacy checker;
// the solver objective itself is 3D distance, reported as distanceM.
const metrics={distanceM:a.distanceM+b.distanceM,horizontalDistanceM:a.horizontalDistanceM+b.horizontalDistanceM,positiveClimbM:a.positiveClimbM+b.positiveClimbM,maxSurfaceSlopeDeg:Math.max(a.maxSurfaceSlopeDeg,b.maxSurfaceSlopeDeg),maxAbsGradeDeg:Math.max(a.maxAbsGradeDeg,b.maxAbsGradeDeg),warningEdgeCount:a.warningEdgeCount+b.warningEdgeCount,cost:a.cost+b.cost,estimatedTimeS:null,averageAbsGradeDeg:averageAbsoluteGrade([outbound,returnLeg])}
if(metrics.distanceM>request.roundTripBudgetM+1e-7)throw new Error('Candidate exceeds the total distance limit')
if(request.objective==='shortest-peak'&&metrics.maxAbsGradeDeg>request.gradeLimitDeg+1e-7)throw new Error('Candidate exceeds the peak walking-grade limit')
const route={status:'ok',datasetVersion:m.datasetVersion,engine:'native-portals-conic-live-1',policy:request.objective==='gentlest'?'minimax-grade':request.objective,start:request.start,target:config.approach.cell,outbound,returnLeg,metrics,scienceWaypointIndex:outbound.points.length-1,turnaroundDistanceM:a.distanceM,portalElevationStepM:witness.portalElevationStepM,polishEngine:witness.polishEngine??null}
const result={schemaVersion:1,status:'live-engine-checked',independentAudit:false,datasetVersion:m.datasetVersion,mode:'continuous',config,options:request,staging,approach,routes:[route],checkedPieces:outbound.points.length+returnLeg.points.length-2,continuousOptimalityBounds:null,roundTripBudgetM:request.roundTripBudgetM}
await writeFile(`${work}/result.json`,JSON.stringify(result))
