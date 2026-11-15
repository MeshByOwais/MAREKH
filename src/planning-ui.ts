import type { Cell, Grid } from './routing/planner.ts'
import { PlanningGeneration, validateStagingCandidate, findNearbyStaging, type PlanningConfig, type LiveMode, type LivePlan, type LiveMessage } from './routing/interactive.ts'
import { profilePoints, createProfileSampler, slopeAlerts, type ProfileRoute, type ProfileSample } from './routing/profile.ts'
import PlanningWorker from './routing/planning.worker.ts?worker&inline'
import { validateContinuousOptions, type ContinuousOptions } from './routing/continuous.ts'

export type InspectableRoute = ProfileRoute & {policy:string}
const node=(id:string)=>document.getElementById(id)!
const input=(id:string)=>node(id) as HTMLInputElement
export function createPlanningUI(grid:Grid, hooks:{
  live(plan:LivePlan,config:PlanningConfig):void; cursor(sample:ProfileSample):void
  choose(index:number,route:InspectableRoute,warningDeg:number):void; candidate(cell:Cell|undefined,valid?:boolean,widthM?:number,heightM?:number):void; searchStarted():void
}) {
  const generation=new PlanningGeneration()
  let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,config:PlanningConfig,mode:'global'|LiveMode='global'
  let routes:InspectableRoute[]=[],selected=0,distance=0,picking=false,download:string|undefined
  let activeStart:Cell|undefined,stagingHazard:Uint8Array|undefined
  let continuousJob:string|undefined
  let profileSample:ReturnType<typeof createProfileSampler>|undefined
  const status=node('placement-status'),form=node('start-form') as HTMLFormElement,slider=input('route-distance')
  function message(text:string,state='idle') {
    status.textContent=text;status.dataset.state=state
    const summary=node('route-placement-status');summary.hidden=false;summary.dataset.state=state
    summary.textContent=activeStart?`Displayed route start: ${activeStart.row}, ${activeStart.column}. ${text}`:text
  }
  function candidate() {
    const row=Number(input('start-row').value),column=Number(input('start-column').value)
    return {row:input('start-row').value===''?NaN:row,column:input('start-column').value===''?NaN:column}
  }
  function previewCandidate() {
    const p=candidate()
    try {
      const footprint=validateStagingCandidate(grid,config,p,stagingHazard)
      hooks.candidate(p,true,config.staging.footprintWidthM,config.staging.footprintHeightM)
      input('start-row').setAttribute('aria-invalid','false');input('start-column').setAttribute('aria-invalid','false')
      message(`Staging ${p.row}, ${p.column} passes the footprint checks (${footprint.maxSlopeDeg.toFixed(2)}° maximum). Choose Plan route to update the walk.`,'ready')
      return true
    }catch(error){
      hooks.candidate(Number.isInteger(p.row)&&Number.isInteger(p.column)?p:undefined,false,config.staging.footprintWidthM,config.staging.footprintHeightM)
      input('start-row').setAttribute('aria-invalid','true');input('start-column').setAttribute('aria-invalid','true')
      message(`New start not applied. ${error instanceof Error?error.message:'Invalid staging.'} Choose another cell or Find nearby valid staging. The displayed route is unchanged.`,'invalid')
      return false
    }
  }
  function stop() {worker?.terminate();worker=undefined;if(timer)clearTimeout(timer);timer=undefined;if(continuousJob){void fetch(`/api/plans/${continuousJob}`,{method:'DELETE'}).catch(()=>{});continuousJob=undefined}node('cancel-search').hidden=true;form.removeAttribute('aria-busy')}
  function cancel(text?:string) {generation.next();stop();if(text)message(text)}
  function label(route:InspectableRoute) {return route.policy==='shortest-peak'?'Shorter · peak-grade limit':route.policy==='shortest'?'Shortest':route.policy==='gentle'?'Gentler terrain':route.policy==='distance'?'Distance priority':route.policy==='terrain'?'Terrain priority':'Gentler · distance limit'}
  function updateCursor(value:number) {
    const route=routes[selected];if(!route)return
    distance=Math.max(0,Math.min(route.metrics.distanceM,value));slider.value=String(distance)
    const sample=profileSample!(distance)
    node('profile-distance').textContent=`${distance.toFixed(2)} / ${route.metrics.distanceM.toFixed(2)} m · ${sample.leg}`
    slider.setAttribute('aria-valuetext',`${distance.toFixed(2)} metres, ${sample.leg}`)
    node('profile-elevation').textContent=Number.isFinite(sample.elevationM)?`${sample.elevationM.toFixed(2)} m`:'Unavailable'
    node('profile-slope').textContent=Number.isFinite(sample.edgeSurfaceSlopeDeg)?`${sample.edgeSurfaceSlopeDeg.toFixed(2)}°`:'Unavailable'
    node('profile-grade').textContent=Number.isFinite(sample.segmentGradeDeg)?`${sample.segmentGradeDeg.toFixed(2)}°`:'Unavailable'
    node('profile-slope').classList.toggle('alert-reading',sample.reasons.length>0)
    const alert=sample.reasons.length?sample.reasons.join(' '):Number.isFinite(sample.edgeSurfaceSlopeDeg)?'No surface-slope warning at this point.':'Surface slope unavailable.'
    if(node('profile-alert').textContent!==alert)node('profile-alert').textContent=alert
    node('profile-alert').classList.toggle('alert-reading',sample.reasons.length>0)
    const cursor=node('profile-cursor'),x=40+920*(route.metrics.distanceM?distance/route.metrics.distanceM:0)
    cursor.setAttribute('x1',String(x));cursor.setAttribute('x2',String(x))
    hooks.cursor(sample)
  }
  function showProfile(index=0) {
    selected=index;const route=routes[index];if(!route)return
    profileSample=createProfileSampler(route,config.rules.warningSlopeDeg)
    const points=profilePoints(route),zs=points.map(p=>p.elevationM).filter(Number.isFinite),low=Math.min(...zs),high=Math.max(...zs),span=Math.max(1,high-low)
    const svg=node('route-profile'),normal:string[]=[],warning:string[]=[]
    const xy=(p:typeof points[number])=>`${40+920*(route.metrics.distanceM?p.cumulativeDistanceM/route.metrics.distanceM:0)},${150-110*(p.elevationM-low)/span}`
    for(let i=1;i<points.length;i++)(slopeAlerts(points[i].edgeSurfaceSlopeDeg,config.rules.warningSlopeDeg).length?warning:normal).push(`M${xy(points[i-1])}L${xy(points[i])}`)
    const turn=40+920*(route.metrics.distanceM?route.turnaroundDistanceM/route.metrics.distanceM:0)
    svg.innerHTML=`<title>Round-trip elevation profile; red pieces exceed the surface slope warning threshold</title><path d="${normal.join('')}" class="profile-line"/><path d="${warning.join('')}" class="profile-warning"/><line x1="${turn}" x2="${turn}" y1="22" y2="164" class="turn-line"/><line id="profile-cursor" y1="25" y2="164" class="cursor-line"/>`
    node('profile-range').textContent=`Elevation ${low.toFixed(2)} to ${high.toFixed(2)} m · Mars 2000 datum · distance includes both legs`
    slider.max=String(route.metrics.distanceM);slider.disabled=false
    ;(node('route-choice') as HTMLSelectElement).value=String(index)
    for(const [i,button]of [...document.querySelectorAll<HTMLButtonElement>('[data-route-choice]')].entries())button.setAttribute('aria-pressed',String(i===index))
    hooks.choose(index,route,config.rules.warningSlopeDeg);updateCursor(0)
  }
  function setRoutes(next:InspectableRoute[]) {
    routes=next;const select=node('route-choice') as HTMLSelectElement;select.replaceChildren()
    routes.forEach((r,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=label(r);select.append(option)})
    node('route-profile-panel').hidden=false
    const same=routes.length===2&&JSON.stringify(routes[0].outbound.points.map(p=>[p.eastM,p.northM]))===JSON.stringify(routes[1].outbound.points.map(p=>[p.eastM,p.northM]))
    node('policy-note').textContent=same?'Both policies produced the same path.':routes.length===1?'Inspect this route along the complete round trip.':'Select a policy to inspect its profile and highlight it on the map.'
    showProfile()
  }
  function refreshMode() {
    ;(node('placement-fields') as HTMLFieldSetElement).disabled=false
    node('continuous-controls').hidden=mode!=='global'
    ;(node('route-objective') as HTMLSelectElement).disabled=mode!=='global'
    input('distance-budget').disabled=mode!=='global'
    node('plan-submit').textContent=mode==='global'?'Plan route':'Plan both routes'
    node('live-start-help').textContent=mode==='global'?'Choose staging and a distance–grade trade-off. This local planner searches native triangle crossings and improves them continuously, using the same system as the saved grade route. Searches can take several minutes. Both legs count toward the distance limit.':'Pick a cell or enter its row and column. The full 10 × 10 m staging square must pass the 5° limit. Find nearby valid staging proposes a passing square within 100 m. Choose Plan both routes to apply it.'
    refreshObjective()
  }
  function refreshObjective(){
    const objective=(node('route-objective') as HTMLSelectElement).value
    input('grade-limit').disabled=mode!=='global'||objective==='gentlest'
    node('grade-limit-label').textContent='Maximum walking grade (°)'
    node('objective-help').textContent=objective==='gentlest'?'Seek the lowest peak walking grade within your total distance budget, then shorten that candidate. Average grade is reported separately.':'Seek a short route whose every native piece stays below the chosen walking-grade cap. The total distance limit is also enforced; increase it to allow longer detours.'
  }
  function applyPlan(plan:LivePlan,planConfig:PlanningConfig,record:unknown){
    stop();config=planConfig;activeStart={...plan.staging.cell};hooks.live(plan,config);setRoutes(plan.routes)
    message(`Plan updated · start ${activeStart.row}, ${activeStart.column} · outbound and return checked${plan.independentAudit?' independently':''}.`,'current');hooks.candidate(undefined)
    if(download)URL.revokeObjectURL(download)
    download=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}))
    const link=node('live-download') as HTMLAnchorElement;link.href=download;link.hidden=false
  }
  async function searchContinuous(id:number,start:Cell,fail:(text:string)=>void){
    try{
      const options:ContinuousOptions={objective:(node('route-objective') as HTMLSelectElement).value as ContinuousOptions['objective'],roundTripBudgetM:Number(input('distance-budget').value),gradeLimitDeg:Number(input('grade-limit').value)}
      validateContinuousOptions(options)
      const response=await fetch('/api/plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...options,start})})
      if(!response.headers.get('Content-Type')?.includes('application/json'))throw new Error('The continuous planner service is unavailable. Start the local planner service on this machine.')
      const job=await response.json();if(!response.ok)throw new Error(job.error??'Could not start the continuous planner.')
      if(!generation.current(id)){void fetch(`/api/plans/${job.id}`,{method:'DELETE'}).catch(()=>{});return}
      continuousJob=job.id
      const poll=async()=>{
        try{
          const statusResponse=await fetch(`/api/plans/${job.id}`,{cache:'no-store'})
          const status=await statusResponse.json();if(!generation.current(id))return
          if(!statusResponse.ok)throw new Error(status.error??'Could not read planning progress.')
          if(status.state==='done'){
            const plan=status.result as LivePlan
            if(plan.independentAudit!==true||plan.mode!=='continuous'||!plan.config)throw new Error('The independent route check did not finish.')
            applyPlan(plan,plan.config,status.result);return
          }
          if(status.state!=='running')throw new Error(status.text??'Search stopped without a result.')
          message(`Planning from ${start.row}, ${start.column}. ${status.text} The current route remains visible.`,'pending')
          timer=setTimeout(()=>void poll(),1000)
        }catch(error){if(generation.current(id))fail(error instanceof Error?error.message:'The planner connection was lost.')}
      }
      void poll()
    }catch(error){if(generation.current(id))fail(error instanceof Error?error.message:'The continuous planner is unavailable.')}
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();if(!config)return
    cancel();if(!previewCandidate())return
    const id=generation.next(),start=candidate();hooks.searchStarted()
    form.setAttribute('aria-busy','true');node('cancel-search').hidden=false;message(`Planning from ${start.row}, ${start.column}… The displayed route will change when the search and checks finish.`,'pending')
    const fail=(text:string)=>{if(!generation.current(id))return;stop();hooks.candidate(start,true,config.staging.footprintWidthM,config.staging.footprintHeightM);message(`New plan not applied. ${text} The displayed route is unchanged.`,'invalid')}
    if(mode==='global'){void searchContinuous(id,start,fail);return}
    try {
      // Keep search startup available after the loaded page loses its server.
      worker=new PlanningWorker()
      worker.onmessage=({data}:MessageEvent<LiveMessage>)=>{
        if(!generation.current(data.id))return
        if(data.type==='progress'){message(`Planning from ${start.row}, ${start.column}. ${data.text} Previous route remains visible.`,'pending');return}
        if(data.type==='error'){fail(data.text);return}
        stop();activeStart={...start};hooks.live(data.plan,config);setRoutes(data.plan.routes)
        message(`Plan updated · start ${start.row}, ${start.column} · both policies checked on outbound and return.`,'current')
        hooks.candidate(undefined)
        if(download)URL.revokeObjectURL(download)
        download=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:1,status:'live-engine-checked',independentAudit:false,continuousOptimalityBounds:null,roundTripBudgetM:null,datasetVersion:grid.datasetVersion,mode,config:{...config,staging:{...config.staging,cell:data.plan.staging.cell}},staging:data.plan.staging,approach:data.plan.approach,routes:data.plan.routes},null,2)],{type:'application/json'}))
        const link=node('live-download') as HTMLAnchorElement;link.href=download;link.hidden=false
      }
      worker.onerror=event=>{console.error('Route worker failed',event.message,event.filename,event.lineno);fail(event.message?`Background search failed: ${event.message}`:'The background planner could not complete the search.')}
      timer=setTimeout(()=>fail('Search exceeded two minutes; try a closer staging point.'),120_000)
      worker.postMessage({id,grid,config,mode,start})
    } catch(error){fail(error instanceof Error?error.message:'The background planner is unavailable.')}
  })
  node('cancel-search').addEventListener('click',()=>cancel('Search cancelled. The current plan is retained.'))
  node('pick-start').addEventListener('click',()=>{picking=!picking;node('pick-start').setAttribute('aria-pressed',String(picking));message(picking?'Click the terrain to select and check a staging square.':'Map clicks inspect terrain.')})
  node('find-staging').addEventListener('click',()=>{
    if(!config)return
    cancel();const requested=candidate()
    try{
      const nearby=findNearbyStaging(grid,config,requested,stagingHazard)
      if(!nearby){message('No passing staging square found within 100 m. Try another part of the map. The displayed route is unchanged.','invalid');return}
      const p=nearby.footprint.cell
      picking=false;node('pick-start').setAttribute('aria-pressed','false');input('start-row').value=String(p.row);input('start-column').value=String(p.column)
      previewCandidate();message(`Suggested staging ${p.row}, ${p.column}, ${nearby.displacementM.toFixed(2)} m from ${requested.row}, ${requested.column}. The full square passes staging checks. Choose Plan route to apply this location; route connectivity will be checked next.`,'ready')
    }catch(error){message(error instanceof Error?error.message:'Could not find nearby staging.','invalid')}
  })
  for(const id of ['start-row','start-column','route-objective','distance-budget','grade-limit'])node(id).addEventListener('input',()=>{cancel();refreshObjective();previewCandidate()})
  node('route-choice').addEventListener('change',event=>showProfile(Number((event.target as HTMLSelectElement).value)))
  node('route-results').addEventListener('click',event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('[data-route-choice]');if(button)showProfile(Number(button.dataset.routeChoice))})
  slider.addEventListener('input',()=>updateCursor(Number(slider.value)))
  node('go-turnaround').addEventListener('click',()=>updateCursor(routes[selected].turnaroundDistanceM))
  node('next-warning').addEventListener('click',()=>{
    const route=routes[selected],points=profilePoints(route),warnings=points.slice(1).flatMap((p,i)=>slopeAlerts(p.edgeSurfaceSlopeDeg,config.rules.warningSlopeDeg).length?[(points[i].cumulativeDistanceM+p.cumulativeDistanceM)/2]:[])
    if(!warnings.length){node('profile-alert').textContent='This route has no surface-slope warnings.';return}
    updateCursor(warnings.find(d=>d>distance+.001)??warnings[0])
  })
  const svg=node('route-profile')
  function scrub(event:PointerEvent){const box=svg.getBoundingClientRect();updateCursor(Math.max(0,Math.min(1,((event.clientX-box.left)/box.width*1000-40)/920))*routes[selected].metrics.distanceM)}
  svg.addEventListener('pointerdown',event=>{if(!routes.length)return;svg.setPointerCapture(event.pointerId);scrub(event)})
  svg.addEventListener('pointermove',event=>{if(svg.hasPointerCapture(event.pointerId))scrub(event)})
  return {
    cancel,
    seek:updateCursor,
    chooseCell(cell:Cell){if(!picking)return false;cancel();picking=false;node('pick-start').setAttribute('aria-pressed','false');input('start-row').value=String(cell.row);input('start-column').value=String(cell.column);previewCandidate();return true},
    saved(next:InspectableRoute[],nextConfig:PlanningConfig,nextMode:typeof mode,hazard?:Uint8Array){cancel();config=nextConfig;mode=nextMode;stagingHazard=hazard;activeStart={...config.staging.cell};input('start-row').value=String(activeStart.row);input('start-column').value=String(activeStart.column);input('start-row').setAttribute('aria-invalid','false');input('start-column').setAttribute('aria-invalid','false');node('live-download').hidden=true;hooks.candidate(undefined);refreshMode();setRoutes(next);message(mode==='global'?'Saved grade candidate loaded. Its bounds apply to this staging point.':'Saved plan loaded. Choose another staging cell to try a new walk.','current')},
  }
}
