import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir} from 'node:fs/promises'
import {readFloatGrid} from '../src/terrain/package.ts'
import {assessCrewTerrain} from '../src/routing/crew-terrain.ts'
import {planCrewRoute} from '../src/routing/crew-planner.ts'
const root=new URL('../',import.meta.url),source=new URL('public/sites/columbia-hills/terrain-v1/',root),dest=new URL('public/sites/columbia-hills/crew-navigation-v1/',root)
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex')
const manifestBytes=await readFile(new URL('manifest.json',source)),m=JSON.parse(manifestBytes.toString()),configBytes=await readFile(new URL('config/columbia-hills/crew-navigation-v1.json',root)),config=JSON.parse(configBytes.toString())
if(m.datasetVersion!==config.datasetVersion)throw new Error('Crew navigation dataset mismatch')
const data=await Promise.all(['elevation.f32','slope-deg.f32','coverage.u8','exclusions.u8'].map(async name=>{const b=await readFile(new URL(name,source));if(sha(b)!==m.assets[name].sha256||b.length!==m.assets[name].bytes)throw new Error(`Input mismatch: ${name}`);return b}))
const grid={...m,elevation:readFloatGrid(data[0]),slope:readFloatGrid(data[1]),coverage:data[2],exclusions:data[3]}
const terrain=assessCrewTerrain(grid,config.rules,config.crewModel)
console.log('Crew terrain assessed:',{hazardCells:terrain.hazard.reduce((a,b)=>a+b,0),blockedCells:terrain.blocked.reduce((a,b)=>a+b,0)})
const routes=[]
for(const policy of ['distance','terrain'] as const){const t=performance.now(),r=planCrewRoute(terrain,config.staging.cell,config.approach.cell,policy,config.localPlanner);routes.push(r);console.log(policy,{elapsedS:(performance.now()-t)/1000,processed:r.expandedCells,localSteps:r.localSteps,points:r.outbound.points.length,metrics:r.metrics})}
await mkdir(dest,{recursive:true})
const baselineManifestBytes=await readFile(new URL('public/sites/columbia-hills/routes-v1/manifest.json',root)),baselineManifest=JSON.parse(baselineManifestBytes.toString()),missionBytes=await readFile(new URL('public/sites/columbia-hills/routes-v1/mission.json',root))
if(sha(missionBytes)!==baselineManifest.assets['mission.json'].sha256)throw new Error('Baseline endpoint record hash mismatch')
const mission=JSON.parse(missionBytes.toString())
for(const name of ['staging','approach'])if(mission[name].cell.row!==config[name].cell.row||mission[name].cell.column!==config[name].cell.column)throw new Error('Changed crew endpoint requires a new footprint record')
mission.routeVersion=config.routeVersion;mission.status='crew-clearance-and-field-guidance-validated';mission.approvalScope='Demo crew-walk constraints and orbital-scale clearance; not operational approval'
const floats=(a:Float32Array)=>{const b=new Uint8Array(a.length*4),v=new DataView(b.buffer);a.forEach((x,i)=>v.setFloat32(i*4,x,true));return b}
const assets:Record<string,Uint8Array>={'config.json':configBytes,'mission.json':new TextEncoder().encode(JSON.stringify(mission,null,2)+'\n'),'routes.json':new TextEncoder().encode(JSON.stringify({schemaVersion:1,routeVersion:config.routeVersion,datasetVersion:m.datasetVersion,engine:config.engine,routes},null,2)+'\n'),'roughness-rms.f32':floats(terrain.roughness),'residual-max.f32':floats(terrain.residual),'hazard.u8':terrain.hazard,'clearance-blocked.u8':terrain.blocked}
for(const [name,b]of Object.entries(assets))await writeFile(new URL(name,dest),b)
await writeFile(new URL('manifest.json',dest),JSON.stringify({schemaVersion:1,routeVersion:config.routeVersion,datasetVersion:m.datasetVersion,engine:config.engine,terrainManifestSha256:sha(manifestBytes),baselineManifestSha256:sha(baselineManifestBytes),configSha256:sha(configBytes),crsWkt:m.crsWkt,rows:m.rows,columns:m.columns,transform:m.transform,assets:Object.fromEntries(Object.entries(assets).map(([n,b])=>[n,{bytes:b.length,sha256:sha(b)}]))},null,2)+'\n')
