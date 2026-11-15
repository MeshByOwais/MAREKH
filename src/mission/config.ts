import {defaultScenario,validateScenario,type Scenario} from './conditions.ts'
export type MissionDescriptor={schemaVersion:1;id:string;name:string;region:string;terrain:string;defaultModel:'global'|'crew'|'baseline';continuousServiceMission:string|null;focusFeatureId:string;context?:{homeLabel:string;scienceLabel:string;stagingLabel:string;reviewUrl?:string};science:{title:string;description:string;image:string;imageAlt:string;credit:string;source:string};packages:Partial<Record<'global'|'crew'|'baseline',{path:string;version:string}>>;scenario:Scenario;credits:string}
export function validateMission(value:MissionDescriptor){
  if(value.schemaVersion!==1||!value.id||!value.name||!value.terrain||!value.packages?.crew||!value.packages[value.defaultModel])throw new Error('Mission descriptor requires terrain, a crew package, and an available default model.')
  validateScenario({...defaultScenario,...value.scenario})
  if(!value.science?.title||!value.science.source||!value.science.image)throw new Error('Mission needs a source-linked science stop.')
  const source=new URL(value.science.source);if(!['https:','http:'].includes(source.protocol))throw new Error('Science source must use an HTTP or HTTPS link.')
  return value
}
export async function loadMission(){
  const path=new URLSearchParams(location.search).get('mission')??`${import.meta.env.BASE_URL}missions/columbia-hills.json`
  const url=new URL(path,location.href)
  if(url.origin!==location.origin||!['http:','https:'].includes(url.protocol))throw new Error('Load a mission descriptor from this app’s own origin.')
  const response=await fetch(url);if(!response.ok)throw new Error('Mission descriptor is unavailable.')
  const descriptor=validateMission(await response.json())
  const asset=(path:string)=>{const value=new URL(path,url);if(value.origin!==url.origin)throw new Error('Mission assets must use the same origin.');return value.href}
  descriptor.terrain=asset(descriptor.terrain)
  for(const p of Object.values(descriptor.packages))p.path=asset(p.path)
  if(descriptor.context?.reviewUrl)descriptor.context.reviewUrl=asset(descriptor.context.reviewUrl)
  descriptor.science.image=asset(descriptor.science.image)
  descriptor.scenario={...defaultScenario,...descriptor.scenario}
  return descriptor
}
