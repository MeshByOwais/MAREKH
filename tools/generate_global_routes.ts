import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises'
import {readFloatGrid} from '../src/terrain/package.ts'
import {assessCrewTerrain} from '../src/routing/crew-terrain.ts'
import {crewLeg} from '../src/routing/crew-planner.ts'

const root=new URL('../',import.meta.url),terrainRoot=new URL('public/sites/columbia-hills/terrain-v1/',root),crewRoot=new URL('public/sites/columbia-hills/crew-navigation-v1/',root),work=new URL('data/work/columbia-hills/global-grade-v1/',root),dest=new URL('public/sites/columbia-hills/global-grade-v1/',root)
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
const json=(b:Uint8Array)=>JSON.parse(new TextDecoder().decode(b))
const terrainBytes=await readFile(new URL('manifest.json',terrainRoot)),m=json(terrainBytes),crewBytes=await readFile(new URL('manifest.json',crewRoot)),cm=json(crewBytes)
async function checked(name:string,base:URL,manifest:typeof m){const b=await readFile(new URL(name,base));if(b.length!==manifest.assets[name].bytes||sha(b)!==manifest.assets[name].sha256)throw new Error(`Input hash mismatch: ${name}`);return b}
const crew=json(await checked('config.json',crewRoot,cm)),config=json(await readFile(new URL('config/columbia-hills/global-grade-v1.json',root)))
const arrays=await Promise.all(['elevation.f32','slope-deg.f32','coverage.u8','exclusions.u8'].map(n=>checked(n,terrainRoot,m)))
const grid={...m,elevation:readFloatGrid(arrays[0]),slope:readFloatGrid(arrays[1]),coverage:arrays[2],exclusions:arrays[3]}
const terrain=assessCrewTerrain(grid,crew.rules,crew.crewModel)
const witness=json(await readFile(new URL('witness.json',work))),mesh=json(await readFile(new URL('mesh.json',work)))
if(witness.needsGradeRealization)throw new Error('A relaxed proposal is not a feasible route')
if(witness.points.length<2)throw new Error('Empty witness')
for(const [p,expected]of [[witness.points[0],crew.staging.cell],[witness.points.at(-1),crew.approach.cell]])if(p.row!==expected.row||p.column!==expected.column)throw new Error('Witness endpoints changed')
const outbound=crewLeg(terrain,witness.points,'distance'),returnLeg=crewLeg(terrain,[...outbound.points].reverse(),'distance')
// This objective is 3D surface distance, independently of the previous crew
// planner's horizontal density cost. Recompute both costs explicitly.
outbound.metrics.cost=outbound.metrics.distanceM;returnLeg.metrics.cost=returnLeg.metrics.distanceM
const a=outbound.metrics,b=returnLeg.metrics
const metrics={distanceM:a.distanceM+b.distanceM,horizontalDistanceM:a.horizontalDistanceM+b.horizontalDistanceM,positiveClimbM:a.positiveClimbM+b.positiveClimbM,maxSurfaceSlopeDeg:Math.max(a.maxSurfaceSlopeDeg,b.maxSurfaceSlopeDeg),maxAbsGradeDeg:Math.max(a.maxAbsGradeDeg,b.maxAbsGradeDeg),warningEdgeCount:a.warningEdgeCount+b.warningEdgeCount,cost:a.cost+b.cost,estimatedTimeS:null}
if(metrics.distanceM>config.roundTripBudgetM||metrics.maxAbsGradeDeg>witness.gradeCapDeg+1e-7)throw new Error(JSON.stringify({message:'Witness violates grade/distance budget',metrics,gradeCapDeg:witness.gradeCapDeg}))
if(process.argv.includes('--verify-only')){console.log({metrics,gradeCapDeg:witness.gradeCapDeg});process.exit(0)}
const assets:Record<string,Uint8Array>={}
const encode=(o:unknown)=>new TextEncoder().encode(JSON.stringify(o,null,2)+'\n')
const certs=[]
for(const name of (await readdir(work)).filter(n=>/^potential-.*\.json$/.test(n))){const c=json(await readFile(new URL(name,work)));certs.push({...c,metadataFile:name})}
const infeasible=certs.filter(c=>c.oneWayDistanceLowerM>config.roundTripBudgetM/2).sort((x,y)=>y.gradeDeg-x.gradeDeg)[0]
const secondary=certs.find(c=>Math.abs(c.gradeDeg-witness.gradeCapDeg)<1e-8)
if(!infeasible||!secondary||infeasible.gradeDeg>=witness.gradeCapDeg)throw new Error('Missing valid grade bracket or secondary-distance certificate')
for(const c of [infeasible,secondary]){const {metadataFile,...record}=c;assets[metadataFile]=encode(record);assets[c.potentialFile]=await readFile(new URL(c.potentialFile,work))}
const gap=witness.gradeCapDeg-infeasible.gradeDeg
const bounds={status:'bounded',gradeLowerDeg:infeasible.gradeDeg,gradeUpperDeg:witness.gradeCapDeg,gradeGapDeg:gap,gradeLowerCertificate:infeasible.potentialFile,secondaryDistanceLowerM:2*secondary.oneWayDistanceLowerM,secondaryDistanceUpperM:metrics.distanceM,secondaryDistanceGapM:metrics.distanceM-2*secondary.oneWayDistanceLowerM,secondaryGradeCapDeg:witness.gradeCapDeg,secondaryCertificate:secondary.potentialFile,roundTripBudgetM:config.roundTripBudgetM,exactOptimumClaimed:false,numerics:'Double precision; conservative potential scaling and a 0.00001 m one-way subtraction. Not an interval-arithmetic proof.',scope:'Continuous piecewise-planar native terrain; static symmetric crew model; distance bounds at the reported feasible grade cap, not exact lexicographic optimum.'}
const route={status:'ok',datasetVersion:m.datasetVersion,engine:config.engine,policy:'minimax-grade',start:crew.staging.cell,target:crew.approach.cell,outbound,returnLeg,metrics,scienceWaypointIndex:outbound.points.length-1,turnaroundDistanceM:a.distanceM,expandedCells:witness.expanded,portalCount:witness.portalCount,searchFaceCount:witness.faceCount,portalElevationStepM:witness.portalElevationStepM,polishEngine:witness.polishEngine??null,optimality:bounds}
const mission=json(await checked('mission.json',crewRoot,cm));mission.routeVersion=config.routeVersion;mission.status='continuous-route-with-numerical-global-bounds'
const fullConfig={...config,rules:crew.rules,crewModel:crew.crewModel,staging:crew.staging,approach:crew.approach}
const domain=Object.fromEntries(['bounds','vertexCount','lowerFaceCount','startIndex','goalIndex','spacingM','oneWayBudgetM'].map(k=>[k,mesh[k]]))
Object.assign(assets,{'config.json':encode(fullConfig),'mission.json':encode(mission),'routes.json':encode({schemaVersion:1,routeVersion:config.routeVersion,datasetVersion:m.datasetVersion,engine:config.engine,routes:[route]}),'bounds.json':encode(bounds),'domain.json':encode(domain)})
await mkdir(dest,{recursive:true})
for(const [name,data]of Object.entries(assets))await writeFile(new URL(name,dest),data)
await writeFile(new URL('manifest.json',dest),encode({schemaVersion:1,routeVersion:config.routeVersion,datasetVersion:m.datasetVersion,engine:config.engine,terrainManifestSha256:sha(terrainBytes),crewManifestSha256:sha(crewBytes),configSha256:sha(assets['config.json']),rows:m.rows,columns:m.columns,transform:m.transform,crsWkt:m.crsWkt,assets:Object.fromEntries(Object.entries(assets).map(([name,data])=>[name,{bytes:data.length,sha256:sha(data)}]))}))
console.log({metrics,bounds})
