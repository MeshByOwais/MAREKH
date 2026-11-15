import type {Incident} from '../routing/incidents.ts'
import {createMissionSampler,validateScenario,minutes,type Scenario,type MissionRoute,type MissionSample,type MissionTiming} from './conditions.ts'
const node=(id:string)=>document.getElementById(id)!
const fieldLabels:Record<Exclude<keyof Scenario,'enabled'>,string>={temperatureC:'Ground baseline · °C',spatialVariationC:'Spatial variation · ±°C / 100 m demo cells',diurnalVariationC:'Daily variation · ±°C',departureHour:'Departure · scenario hour (0–24)',pressurePa:'Regional pressure · Pa',doseRateUSvH:'Constant dose-equivalent rate · µSv/h',walkingSpeedMS:'Level-ground walking speed · m/s',gradePenalty:'Walking slowdown per absolute rise/run',samplingMinutes:'Planned science stop · min',missionBudgetMinutes:'Total mission time budget · min',reserveMinutes:'Return reserve · min',coldAlertC:'Cold-ground alert · °C or below',doseAlertUSv:'Cumulative dose alert · µSv or above'}
export function createMissionPanel(initial:Scenario,hooks:{changed():void;pause():void;returnWithoutSampling():void}){
  let incidents:Incident[]=[]
  let scenario={...initial},route:MissionRoute|undefined,warning=10,sampler:ReturnType<typeof createMissionSampler>|undefined,lastDistance=0
  const form=node('scenario-form') as HTMLFormElement,fields=node('scenario-fields')
  for(const key of Object.keys(fieldLabels) as (keyof typeof fieldLabels)[]){
    const label=document.createElement('label');label.textContent=fieldLabels[key]
    const input=document.createElement('input');input.type='number';input.step='any';input.id=`scenario-${key}`;input.name=key;input.required=true;input.value=String(scenario[key]);label.append(input);fields.append(label)
  }
  ;(node('scenario-enabled') as HTMLInputElement).checked=scenario.enabled
  function syncInputs(){for(const key of Object.keys(fieldLabels) as (keyof typeof fieldLabels)[])(node(`scenario-${key}`) as HTMLInputElement).value=String(scenario[key])}
  function setRoute(next:MissionRoute,nextWarning:number){route=next;warning=nextWarning;sampler=createMissionSampler(route,scenario,warning,incidents)}
  function write(id:string,text:string,alert=false){const n=node(id);n.textContent=text;n.classList.toggle('alert-reading',alert)}
  function update(distance:number):MissionSample|undefined{
    if(!route||!sampler)return
    lastDistance=distance
    const p=sampler.sample(distance),c=p.conditions,t=sampler.timing,has=(kind:string)=>c.alerts.some(a=>a.kind===kind)
    for(const prefix of ['segment','profile','hud']){
      write(`${prefix}-temperature`,c.temperatureC===null?'Unavailable':`${c.temperatureC.toFixed(1)} °C`,has('temperature'))
      write(`${prefix}-radiation`,c.doseUSv===null?'Unavailable':`${c.doseUSv.toFixed(2)} µSv`,has('radiation'))
      write(`${prefix}-elapsed`,minutes(c.elapsedS),has('budget'))
    }
    write('segment-slope',c.coverageUnavailable?'Unavailable':`${p.edgeSurfaceSlopeDeg.toFixed(2)}°`,has('slope'))
    write('segment-grade',c.coverageUnavailable?'Unavailable':`${p.segmentGradeDeg.toFixed(2)}°`)
    write('segment-position',`${p.distanceM.toFixed(1)} m · ${p.leg}`)
    write('segment-alert',p.reasons.length?p.reasons.join(' '):'No scenario alerts at this point.',p.reasons.length>0)
    write('regional-pressure',c.pressurePa===null?'Unavailable':`${c.pressurePa.toFixed(0)} Pa`)
    write('regional-rate',scenario.enabled?`${scenario.doseRateUSvH.toFixed(2)} µSv/h`:'Unavailable')
    write('mission-duration',`${minutes(t.totalS)} + ${scenario.reserveMinutes} min reserve`,t.totalS/60+scenario.reserveMinutes>scenario.missionBudgetMinutes)
    write('mission-remaining',`${minutes(c.remainingS)} of ${scenario.missionBudgetMinutes} min`)
    write('mission-return',`${minutes(c.returnS)} estimated return`)
    write('mission-sampling',route.scienceStop===false?'Science stop skipped':`${t.availableSamplingMinutes.toFixed(1)} min maximum science time`,route.scienceStop!==false&&scenario.samplingMinutes>t.availableSamplingMinutes)
    write('mission-turnback',route.scienceStop===false?'Return selected. No further science stop is planned.':`Latest science departure: mission minute ${Math.max(0,t.latestScienceDepartureMinutes).toFixed(1)}. ${t.latestScienceDepartureMinutes<0?'The return alone exceeds the budget and reserve.':''}`)
    const left=(scenario.missionBudgetMinutes-scenario.reserveMinutes)*60-c.elapsedS-c.returnS
    write('mission-decision',route.scienceStop===false?`${minutes(c.returnS)} to the rover + ${scenario.reserveMinutes} min reserve. ${left>=0?'Fits the remaining time budget.':'Exceeds the remaining time budget.'}`:left>=0?`${minutes(left)} remain for stops before the return reserve is used.`:`Return estimate is ${minutes(-left)} beyond the reserved budget.`,left<0)
    write('science-window',`${t.availableSamplingMinutes.toFixed(1)} min available for sampling; ${(route.scienceMinutes??scenario.samplingMinutes).toFixed(1)} min planned; ${(route.samplingSpentMinutes??0).toFixed(1)} min spent. ${t.totalS/60+scenario.reserveMinutes>scenario.missionBudgetMinutes?'The current plan exceeds the time budget.':'The current plan fits the time budget and reserve.'}`)
    write('scenario-status',scenario.enabled?'Synthetic ground temperature · historical Gale RAD rate used as a constant scenario · assumed regional pressure.':'Environmental readings disabled; terrain and walking-time model remain active.')
    return p
  }
  form.addEventListener('submit',event=>{
    event.preventDefault()
    try{
      const next={enabled:(node('scenario-enabled') as HTMLInputElement).checked} as Scenario
      for(const key of Object.keys(fieldLabels) as (keyof typeof fieldLabels)[])next[key]=Number((node(`scenario-${key}`) as HTMLInputElement).value)
      scenario={...validateScenario(next)};hooks.pause();if(route)setRoute(route,warning);hooks.changed();update(lastDistance)
      node('scenario-error').textContent='Scenario applied. Route geometry is unchanged; time, exposure and alerts have been recalculated.'
    }catch(error){node('scenario-error').textContent=error instanceof Error?error.message:'Invalid scenario.'}
  })
  node('science-add-time').addEventListener('click',()=>{
    if(!route)return
    const nextMinutes=(route.samplingSpentMinutes??0)+5
    if(nextMinutes>240){node('science-window').textContent='The demo supports up to 240 minutes of sampling.';return}
    route.samplingSpentMinutes=nextMinutes;hooks.pause();setRoute(route,warning);hooks.changed();update(lastDistance)
  })
  node('science-return-now').addEventListener('click',()=>{if(!route)return;route.scienceMinutes=0;setRoute(route,warning);hooks.changed();update(lastDistance);hooks.returnWithoutSampling()})
  node('scenario-reset').addEventListener('click',()=>{scenario={...initial};syncInputs();(node('scenario-enabled') as HTMLInputElement).checked=scenario.enabled;hooks.pause();if(route)setRoute(route,warning);hooks.changed();update(lastDistance);node('scenario-error').textContent='Demonstration defaults restored.'})
  return {setIncidents(value:Incident[]){incidents=value;if(route)setRoute(route,warning)},get scenario(){return {...scenario}},get timing():MissionTiming|undefined{return sampler?.timing},setRoute,update,sample:(distance:number)=>sampler?.sample(distance),
    summary(next:MissionRoute){const s=createMissionSampler(next,scenario,warning);return s.timing},
    resetSampling(){if(route){route.samplingSpentMinutes=0;delete route.scienceMinutes;setRoute(route,warning);hooks.changed()}},
    refresh(){if(route)setRoute(route,warning);return update(lastDistance)}}
}
