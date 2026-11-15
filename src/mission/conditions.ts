import type {Incident} from '../routing/incidents.ts'
import {createProfileSampler, profilePoints, type ProfileRoute, type ProfileSample} from '../routing/profile.ts'

export type Scenario = {
  enabled:boolean; temperatureC:number; spatialVariationC:number; diurnalVariationC:number; departureHour:number
  pressurePa:number; doseRateUSvH:number; walkingSpeedMS:number; gradePenalty:number
  samplingMinutes:number; missionBudgetMinutes:number; reserveMinutes:number; coldAlertC:number; doseAlertUSv:number
}
export const defaultScenario:Scenario={enabled:true,temperatureC:-60,spatialVariationC:8,diurnalVariationC:12,departureHour:12,pressurePa:636,doseRateUSvH:27.9166666667,walkingSpeedMS:.6,gradePenalty:4,samplingMinutes:10,missionBudgetMinutes:60,reserveMinutes:10,coldAlertC:-65,doseAlertUSv:15}
const limits:Record<Exclude<keyof Scenario,'enabled'>,[number,number]>={temperatureC:[-150,50],spatialVariationC:[0,50],diurnalVariationC:[0,50],departureHour:[0,24],pressurePa:[1,2000],doseRateUSvH:[0,10000],walkingSpeedMS:[.05,2],gradePenalty:[0,20],samplingMinutes:[0,240],missionBudgetMinutes:[1,1440],reserveMinutes:[0,240],coldAlertC:[-150,50],doseAlertUSv:[.01,10000]}
export function validateScenario(value:Scenario){
  if(typeof value.enabled!=='boolean')throw new Error('Choose whether the environmental scenario is enabled.')
  for(const [key,[lo,hi]] of Object.entries(limits)){
    const v=value[key as Exclude<keyof Scenario,'enabled'>]
    if(!Number.isFinite(v)||v<lo||v>hi)throw new Error(`${key} must be between ${lo} and ${hi}.`)
  }
  if(value.reserveMinutes>=value.missionBudgetMinutes)throw new Error('Return reserve must be smaller than the mission budget.')
  return value
}
export type MissionRoute=ProfileRoute & {scienceStop?:boolean;completedDistanceM?:number;scienceMinutes?:number;samplingSpentMinutes?:number;name?:string}
export function createTiming(route:MissionRoute,scenario:Scenario){
  validateScenario(scenario)
  const points=profilePoints(route),times=new Float64Array(points.length)
  for(let i=1;i<points.length;i++){
    const distance=points[i].cumulativeDistanceM-points[i-1].cumulativeDistanceM
    const grade=Math.min(89,Math.abs(points[i].segmentGradeDeg))
    times[i]=times[i-1]+distance/scenario.walkingSpeedMS*(1+scenario.gradePenalty*Math.tan(grade*Math.PI/180))
  }
  const walkingAt=(distance:number)=>{
    const d=Math.max(0,Math.min(route.metrics.distanceM,distance));let lo=0,hi=points.length-1
    while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].cumulativeDistanceM<d)lo=mid+1;else hi=mid}
    if(!lo)return 0
    const a=points[lo-1].cumulativeDistanceM,b=points[lo].cumulativeDistanceM
    return times[lo-1]+(times[lo]-times[lo-1])*(b>a?(d-a)/(b-a):0)
  }
  const scienceMinutes=route.scienceMinutes??(route.scienceStop===false?0:scenario.samplingMinutes)
  const spentS=(route.samplingSpentMinutes??0)*60
  const stopS=Math.max(scienceMinutes*60,spentS),walkingS=times.at(-1)??0,turnWalkingS=walkingAt(route.turnaroundDistanceM)
  return {walkingAt,walkingS,stopS,spentS,totalS:walkingS+stopS,turnWalkingS,returnS:walkingS-turnWalkingS,
    elapsedAt:(d:number)=>walkingAt(d)+(d>route.turnaroundDistanceM+1e-8?stopS:Math.abs(d-route.turnaroundDistanceM)<=1e-8?spentS:0),
    availableSamplingMinutes:Math.max(0,scenario.missionBudgetMinutes-scenario.reserveMinutes-walkingS/60),
    latestScienceDepartureMinutes:scenario.missionBudgetMinutes-scenario.reserveMinutes-(walkingS-turnWalkingS)/60}
}
export type MissionTiming=ReturnType<typeof createTiming>
export type AlertKind='slope'|'temperature'|'radiation'|'budget'|'coverage'|'obstacle'
export type ConditionAlert={kind:AlertKind;text:string}
export type Conditions={temperatureC:number|null;pressurePa:number|null;doseUSv:number|null;elapsedS:number;remainingS:number;returnS:number;samplingAvailableMinutes:number;alerts:ConditionAlert[];coverageUnavailable:boolean}
/** All environmental variation is synthetic, spatially coherent at 100 m, and independent of preview pace. */
export function conditionsAt(sample:ProfileSample,route:MissionRoute,timing:MissionTiming,scenario:Scenario,warningDeg:number,incidents:Incident[]=[]):Conditions{
  const elapsedS=timing.elapsedAt(sample.distanceM)
  const phase=2*Math.PI*(scenario.departureHour+elapsedS/3600-12)/24
  const spatial=Math.sin(Math.floor(sample.eastM/100)*.91+Math.floor(sample.northM/100)*.57)
  const temperatureC=scenario.enabled?scenario.temperatureC+scenario.spatialVariationC*spatial+scenario.diurnalVariationC*Math.cos(phase):null
  const doseUSv=scenario.enabled?scenario.doseRateUSvH*elapsedS/3600:null
  const alerts:ConditionAlert[]=[]
  const here=incidents.filter(i=>sample.distanceM>(route.completedDistanceM??i.reportedAtDistanceM??0)+1e-7&&Math.hypot(sample.eastM-i.eastM,sample.northM-i.northM)<=i.radiusM)
  const coverageUnavailable=here.some(i=>i.kind==='gap')
  if(coverageUnavailable)alerts.push({kind:'coverage',text:'Terrain detail unavailable: this proposed piece crosses a simulated coverage gap. Replan before continuing.'})
  if(here.some(i=>i.kind==='obstacle'))alerts.push({kind:'obstacle',text:'Reported obstacle: this proposed piece crosses a simulated boulder field. Replan before continuing.'})
  if(!coverageUnavailable&&sample.edgeSurfaceSlopeDeg>warningDeg)alerts.push({kind:'slope',text:`Steep surface: ${sample.edgeSurfaceSlopeDeg.toFixed(2)}° > ${warningDeg}°.`})
  if(temperatureC!==null&&temperatureC<=scenario.coldAlertC)alerts.push({kind:'temperature',text:`Cold ground scenario: ${temperatureC.toFixed(1)}°C ≤ ${scenario.coldAlertC}°C.`})
  if(doseUSv!==null&&doseUSv>=scenario.doseAlertUSv)alerts.push({kind:'radiation',text:`Cumulative exposure scenario: ${doseUSv.toFixed(2)} µSv ≥ ${scenario.doseAlertUSv} µSv.`})
  const remainingS=Math.max(0,scenario.missionBudgetMinutes*60-elapsedS)
  // Before science, the previously walked path provides a return-time estimate. After science, use the planned remaining return.
  const returnS=sample.distanceM<route.turnaroundDistanceM?timing.walkingAt(sample.distanceM):Math.max(0,timing.walkingS-timing.walkingAt(sample.distanceM))
  if(elapsedS+returnS+scenario.reserveMinutes*60>scenario.missionBudgetMinutes*60)alerts.push({kind:'budget',text:'Return estimate plus reserve exceeds the remaining mission budget.'})
  return {temperatureC,pressurePa:scenario.enabled?scenario.pressurePa:null,doseUSv,elapsedS,remainingS,returnS,samplingAvailableMinutes:timing.availableSamplingMinutes,alerts,coverageUnavailable}
}
export type MissionSample=ProfileSample & {conditions:Conditions}
export function createMissionSampler(route:MissionRoute,scenario:Scenario,warningDeg:number,incidents:Incident[]=[]){
  const sample=createProfileSampler(route,warningDeg),timing=createTiming(route,scenario)
  return {timing,sample:(distance:number):MissionSample=>{const p=sample(distance),conditions=conditionsAt(p,route,timing,scenario,warningDeg,incidents);return {...p,conditions,reasons:conditions.alerts.map(a=>a.text)}}}
}
export function minutes(seconds:number){return `${(seconds/60).toFixed(1)} min`}
