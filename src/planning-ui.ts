import {createMissionPanel} from './mission/panel.ts'
import {defaultScenario,createTiming,minutes,type Scenario,type MissionRoute} from './mission/conditions.ts'
import {segmentTouchesIncident,incidentContains,type Incident,type IncidentMessage,type IncidentChoice} from './routing/incidents.ts'
import IncidentWorker from './routing/incident.worker.ts?worker&inline'
import type { Cell, Grid } from './routing/planner.ts'
import { PlanningGeneration, validateStagingCandidate, findNearbyStaging, type PlanningConfig, type LiveMode, type LivePlan, type LiveMessage } from './routing/interactive.ts'
import { profilePoints, createProfileSampler, slopeAlerts, type ProfileRoute, type ProfileSample } from './routing/profile.ts'
import PlanningWorker from './routing/planning.worker.ts?worker&inline'
import { validateContinuousOptions, type ContinuousOptions,type ContinuousBounds } from './routing/continuous.ts'

export type InspectableRoute = MissionRoute & {policy:string;request?:ContinuousOptions;bounds?:ContinuousBounds}
const node=(id:string)=>document.getElementById(id)!
const input=(id:string)=>node(id) as HTMLInputElement
export function createPlanningUI(grid:Grid, hooks:{
  live(plan:LivePlan,config:PlanningConfig):void; cursor(sample:ProfileSample):void
  choose(index:number,route:InspectableRoute,warningDeg:number):void; candidate(cell:Cell|undefined,valid?:boolean,widthM?:number,heightM?:number):void; searchStarted():void
  routesUpdated(routes:InspectableRoute[]):void;incidents(incidents:Incident[]):void;pause():void;continueReturn():void;briefing():void
},initialScenario:Scenario=defaultScenario,continuousMissionId:string|null='columbia-hills') {
  const generation=new PlanningGeneration()
  let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,config:PlanningConfig,mode:'global'|LiveMode='global'
  let routes:InspectableRoute[]=[],selected=0,distance=0,picking=false,download:string|undefined,lastRecord:Record<string,unknown>={}
  let activeStart:Cell|undefined,stagingHazard:Uint8Array|undefined
  let continuousJob:string|undefined
  let profileSample:ReturnType<typeof createProfileSampler>|undefined
  let incidentWorker:Worker|undefined,incidentTimer:ReturnType<typeof setTimeout>|undefined,incidentGeneration=0,incidents:Incident[]=[],incidentChoices:IncidentChoice[]=[],incidentPicking=false,incidentDirty=false,originalRoutes:InspectableRoute[]|undefined
  let cacheKey='',continuousCache:LivePlan[]=[],dropoffs:Partial<Record<'A'|'B',Cell>>={},dropoffPlans:LivePlan[]=[]
  const mission=createMissionPanel(initialScenario,{changed(){if(routes.length){showProfile(selected,false);hooks.routesUpdated(routes);if(incidentChoices.length)renderIncidentChoices()}},pause:()=>hooks.pause(),returnWithoutSampling:()=>hooks.continueReturn()})
  const status=node('placement-status'),form=node('start-form') as HTMLFormElement,slider=input('route-distance')
  function message(text:string,state='idle') {
    status.textContent=text;status.dataset.state=state
    const summary=node('route-placement-status');summary.hidden=false;summary.dataset.state=state
    summary.textContent=text
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
      message(`New start not applied. ${error instanceof Error?error.message:'Invalid staging.'} Choose another start or use Find nearby start. The displayed route is unchanged.`,'invalid')
      return false
    }
  }
  function stop() {worker?.terminate();worker=undefined;if(timer)clearTimeout(timer);timer=undefined;if(continuousJob){void fetch(`/api/plans/${continuousJob}`,{method:'DELETE'}).catch(()=>{});continuousJob=undefined}node('cancel-search').hidden=true;form.removeAttribute('aria-busy')}
  function cancel(text?:string) {generation.next();stop();if(text)message(text)}
  function label(route:InspectableRoute) {return route.name?route.name:route.policy==='shortest-peak'?'Shorter · peak-grade limit':route.policy==='shortest'?'Shortest':route.policy==='gentle'?'Gentler terrain':route.policy==='distance'?'Distance priority':route.policy==='terrain'?'Terrain priority':'Gentler · distance limit'}
  function updateCursor(value:number) {
    const route=routes[selected];if(!route)return
    if(Math.abs(value-distance)>1e-6&&(incidentWorker||incidentChoices.length)){stopIncident();incidentChoices=[];node('incident-results').replaceChildren();node('incident-status').textContent='Position changed. Recompute detour / return for this position.'}
    distance=Math.max(0,Math.min(route.metrics.distanceM,value));slider.value=String(distance)
    const sample=mission.update(distance)??profileSample!(distance)
    node('profile-distance').textContent=`${distance.toFixed(2)} / ${route.metrics.distanceM.toFixed(2)} m · ${sample.leg}`
    slider.setAttribute('aria-valuetext',`${distance.toFixed(2)} metres, ${sample.leg}`)
    const unknown='conditions' in sample&&!!(sample.conditions as {coverageUnavailable?:boolean}).coverageUnavailable
    node('profile-elevation').textContent=!unknown&&Number.isFinite(sample.elevationM)?`${sample.elevationM.toFixed(2)} m`:'Unavailable'
    node('profile-slope').textContent=!unknown&&Number.isFinite(sample.edgeSurfaceSlopeDeg)?`${sample.edgeSurfaceSlopeDeg.toFixed(2)}°`:'Unavailable'
    node('profile-grade').textContent=!unknown&&Number.isFinite(sample.segmentGradeDeg)?`${sample.segmentGradeDeg.toFixed(2)}°`:'Unavailable'
    node('profile-slope').classList.toggle('alert-reading',!unknown&&sample.edgeSurfaceSlopeDeg>config.rules.warningSlopeDeg)
    const alert=sample.reasons.length?sample.reasons.join(' '):Number.isFinite(sample.edgeSurfaceSlopeDeg)?'No terrain or scenario alert at this point.':'Surface slope unavailable.'
    if(node('profile-alert').textContent!==alert)node('profile-alert').textContent=alert
    node('profile-alert').classList.toggle('alert-reading',sample.reasons.length>0)
    const cursor=node('profile-cursor'),x=40+920*(route.metrics.distanceM?distance/route.metrics.distanceM:0)
    cursor.setAttribute('x1',String(x));cursor.setAttribute('x2',String(x))
    hooks.cursor(sample)
  }
  function showProfile(index=0,reset=true) {
    if(reset&&(incidentWorker||incidentChoices.length)){stopIncident();incidentChoices=[];node('incident-results').replaceChildren()}
    selected=index;const route=routes[index];if(!route)return
    profileSample=createProfileSampler(route,config.rules.warningSlopeDeg);mission.setRoute(route,config.rules.warningSlopeDeg)
    const points=profilePoints(route),zs=points.map(p=>p.elevationM).filter(Number.isFinite),low=Math.min(...zs),high=Math.max(...zs),span=Math.max(1,high-low)
    const svg=node('route-profile'),normal:string[]=[],warning:string[]=[]
    const xy=(p:typeof points[number])=>`${40+920*(route.metrics.distanceM?p.cumulativeDistanceM/route.metrics.distanceM:0)},${150-110*(p.elevationM-low)/span}`
    for(let i=1;i<points.length;i++)(mission.sample((points[i-1].cumulativeDistanceM+points[i].cumulativeDistanceM)/2)!.reasons.length?warning:normal).push(`M${xy(points[i-1])}L${xy(points[i])}`)
    const turn=40+920*(route.metrics.distanceM?route.turnaroundDistanceM/route.metrics.distanceM:0)
    svg.innerHTML=`<title>Round-trip elevation profile; red pieces have terrain or environmental scenario alerts</title><path d="${normal.join('')}" class="profile-line"/><path d="${warning.join('')}" class="profile-warning"/><line x1="${turn}" x2="${turn}" y1="22" y2="164" class="turn-line"/><line id="profile-cursor" y1="25" y2="164" class="cursor-line"/>`
    node('profile-range').textContent=`Elevation ${low.toFixed(2)} to ${high.toFixed(2)} m · Mars 2000 datum · distance includes both legs`
    slider.max=String(route.metrics.distanceM);slider.disabled=false
    ;(node('route-choice') as HTMLSelectElement).value=String(index)
    for(const [i,button]of [...document.querySelectorAll<HTMLButtonElement>('[data-route-choice]')].entries())button.setAttribute('aria-pressed',String(i===index))
    node('profile-turn-label').textContent=route.scienceStop===false?'Return decision':'Science turnaround';node('go-turnaround').textContent=route.scienceStop===false?'Return decision':'Science turnaround'
    const evidence=node('selected-route-proof')
    evidence.textContent=route.request?`${route.request.objective==='gentlest'?'Gentler candidate':'Shorter candidate'} · distance ceiling ${route.request.roundTripBudgetM} m${route.request.objective==='shortest-peak'?` · peak cap ${route.request.gradeLimitDeg}°`:''}. ${route.bounds?`Global peak-grade bracket ${route.bounds.gradeLowerDeg.toFixed(3)}–${route.bounds.gradeUpperDeg.toFixed(3)}°; distance bracket ${route.bounds.distanceLowerM.toFixed(2)}–${route.bounds.distanceUpperM.toFixed(2)} m at its reported cap. Exact optimum unknown.`:''}`:route.name?'Incident route: future pieces checked by the crew engine; no independent source audit or continuous optimality bound.':''
    if(reset)hooks.choose(index,route,config.rules.warningSlopeDeg)
    updateCursor(reset?(route.completedDistanceM??0):distance)
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
    node('plan-submit').textContent=mode==='global'?'Plan route':'Plan both routes';node('compare-continuous').hidden=mode!=='global';(node('compare-dropoffs') as HTMLButtonElement).disabled=mode!=='global'
    node('live-start-help').textContent=mode==='global'?'Choose staging and a distance–grade trade-off. This local planner searches native triangle crossings and improves them continuously, using the same system as the saved grade route. Searches can take several minutes. Both legs count toward the distance limit.':'Pick a cell or enter its row and column. The full 10 × 10 m staging square must pass the 5° limit. Find nearby valid staging proposes a passing square within 100 m. Choose Plan route to apply it.'
    refreshObjective()
  }
  function refreshObjective(){
    const objective=(node('route-objective') as HTMLSelectElement).value
    input('grade-limit').disabled=mode!=='global'
    node('grade-limit-label').textContent='Steepness limit · °'
    node('objective-help').textContent=objective==='gentlest'?'Find the least-steep walk within your distance limit. Finding both options also uses the steepness limit for the shorter route.':'Find a short walk that stays within both limits. Steepness means the steepest section, not the average.'
  }
  function applyPlan(plan:LivePlan,planConfig:PlanningConfig,record:unknown){
    for(const route of plan.routes as InspectableRoute[]){delete route.samplingSpentMinutes;delete route.scienceMinutes;delete route.completedDistanceM}
    lastRecord=(record&&typeof record==='object'?record:{}) as Record<string,unknown>;stop();config=planConfig;activeStart={...plan.staging.cell};input('start-row').value=String(activeStart.row);input('start-column').value=String(activeStart.column);hooks.live(plan,config);setRoutes(plan.routes)
    message(`Plan updated · start ${activeStart.row}, ${activeStart.column} · outbound and return checked${plan.independentAudit?' independently':''}.`,'current');hooks.candidate(undefined)
    if(download)URL.revokeObjectURL(download)
    download=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}))
    const link=node('live-download') as HTMLAnchorElement;link.href=download;link.hidden=false
  }
  function continuousOptions():ContinuousOptions{return {objective:(node('route-objective') as HTMLSelectElement).value as ContinuousOptions['objective'],roundTripBudgetM:Number(input('distance-budget').value),gradeLimitDeg:Number(input('grade-limit').value)}}
  async function requestContinuous(id:number,start:Cell,options:ContinuousOptions):Promise<LivePlan>{
    validateContinuousOptions(options)
    const service=await fetch('/api/planner').then(r=>r.json()).catch(()=>null)
    if(!continuousMissionId||service?.missionId!==continuousMissionId)throw new Error('This mission is not registered with the running continuous service. Use its crew planner or start the matching service.')
    const response=await fetch('/api/plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...options,start})})
    if(!response.headers.get('Content-Type')?.includes('application/json'))throw new Error('The continuous planner service is unavailable. Start the local planner service on this machine.')
    const job=await response.json();if(!response.ok)throw new Error(job.error??'Could not start the continuous planner.')
    if(!generation.current(id)){void fetch(`/api/plans/${job.id}`,{method:'DELETE'}).catch(()=>{});throw new Error('Search cancelled.')}
    continuousJob=job.id
    return new Promise((resolve,reject)=>{
      const poll=async()=>{
        try{
          if(!generation.current(id)){reject(new Error('Search cancelled.'));return}
          const response=await fetch(`/api/plans/${job.id}`,{cache:'no-store'}),status=await response.json()
          if(!generation.current(id)){reject(new Error('Search cancelled.'));return}
          if(!response.ok)throw new Error(status.error??'Could not read planning progress.')
          if(status.state==='done'){
            continuousJob=undefined
            const plan=status.result as LivePlan
            if(plan.independentAudit!==true||plan.mode!=='continuous'||!plan.config)throw new Error('The independent route check did not finish.')
            for(const route of plan.routes as InspectableRoute[]){route.request={...options};route.bounds=plan.continuousOptimalityBounds}
            resolve(plan);return
          }
          if(status.state!=='running')throw new Error(status.text??'Search stopped without a result.')
          message(`Start ${start.row}, ${start.column} · ${options.objective==='gentlest'?'gentler':'shorter'} candidate. ${status.text} Current route retained.`,'pending')
          timer=setTimeout(()=>void poll(),1000)
        }catch(error){reject(error)}
      };void poll()
    })
  }
  async function searchContinuous(id:number,start:Cell,fail:(text:string)=>void,both=false){
    try{
      const options=continuousOptions(),key=JSON.stringify({start,budget:options.roundTripBudgetM,cap:options.gradeLimitDeg})
      const results:LivePlan[]=[]
      for(const objective of both?['shortest-peak','gentlest'] as const:[options.objective]){
        results.push(await requestContinuous(id,start,{...options,objective}));if(!generation.current(id))return
      }
      if(key!==cacheKey){continuousCache=[];cacheKey=key}
      for(const plan of results){continuousCache=continuousCache.filter(p=>p.options!.objective!==plan.options!.objective);continuousCache.push(plan)}
      continuousCache.sort((a,b)=>Number(a.options!.objective==='gentlest')-Number(b.options!.objective==='gentlest'))
      const first=continuousCache[0],combined={...first,routes:continuousCache.flatMap(p=>p.routes),checkedPieces:continuousCache.reduce((n,p)=>n+p.checkedPieces,0)}
      resetIncidents(false)
      applyPlan(combined,first.config!,{...combined,comparisonEvidence:continuousCache,environmentalScenario:mission.scenario})
    }catch(error){if(generation.current(id))fail(error instanceof Error?error.message:'The continuous planner is unavailable.')}
  }
  function submitSearch(both=false){
    if(!config)return
    cancel();if(!previewCandidate())return
    const id=generation.next(),start=candidate();hooks.searchStarted()
    form.setAttribute('aria-busy','true');node('cancel-search').hidden=false;message(`Planning from ${start.row}, ${start.column}… The displayed route will change when the search and checks finish.`,'pending')
    const fail=(text:string)=>{if(!generation.current(id))return;stop();hooks.candidate(start,true,config.staging.footprintWidthM,config.staging.footprintHeightM);message(`New plan not applied. ${text} The displayed route is unchanged.`,'invalid')}
    if(mode==='global'){void searchContinuous(id,start,fail,both);return}
    try {
      // Keep search startup available after the loaded page loses its server.
      worker=new PlanningWorker()
      worker.onmessage=({data}:MessageEvent<LiveMessage>)=>{
        if(!generation.current(data.id))return
        if(data.type==='progress'){message(`Planning from ${start.row}, ${start.column}. ${data.text} Previous route remains visible.`,'pending');return}
        if(data.type==='error'){fail(data.text);return}
        lastRecord={status:'live-engine-checked',independentAudit:false};stop();resetIncidents(false);activeStart={...start};hooks.live(data.plan,config);setRoutes(data.plan.routes)
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
  }
  form.addEventListener('submit',event=>{event.preventDefault();submitSearch()})
  node('compare-continuous').addEventListener('click',()=>{if(form.reportValidity())submitSearch(true)})
  node('cancel-search').addEventListener('click',()=>cancel('Search cancelled. The current plan is retained.'))
  node('pick-start').addEventListener('click',()=>{picking=!picking;node('pick-start').setAttribute('aria-pressed',String(picking));message(picking?'Click the map to choose a start.':'Start selection stopped. Click the map to inspect terrain.')})
  node('find-staging').addEventListener('click',()=>{
    if(!config)return
    cancel();const requested=candidate()
    try{
      const nearby=findNearbyStaging(grid,config,requested,stagingHazard)
      if(!nearby){message('No valid start found within 100 m. Choose another area. Your route is unchanged.','invalid');return}
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
    const route=routes[selected],points=profilePoints(route),warnings=points.slice(1).flatMap((p,i)=>mission.sample((points[i].cumulativeDistanceM+p.cumulativeDistanceM)/2)!.reasons.length?[(points[i].cumulativeDistanceM+p.cumulativeDistanceM)/2]:[])
    if(!warnings.length){node('profile-alert').textContent='This route has no terrain or scenario alerts.';return}
    updateCursor(warnings.find(d=>d>distance+.001)??warnings[0])
  })
  const svg=node('route-profile')
  function scrub(event:PointerEvent){const box=svg.getBoundingClientRect();updateCursor(Math.max(0,Math.min(1,((event.clientX-box.left)/box.width*1000-40)/920))*routes[selected].metrics.distanceM)}
  svg.addEventListener('pointerdown',event=>{if(!routes.length)return;svg.setPointerCapture(event.pointerId);scrub(event)})
  svg.addEventListener('pointermove',event=>{if(svg.hasPointerCapture(event.pointerId))scrub(event)})
  function stopIncident(){incidentGeneration++;incidentWorker?.terminate();incidentWorker=undefined;if(incidentTimer)clearTimeout(incidentTimer);node('incident-cancel').hidden=true}
  function resetIncidents(restore=true){
    stopIncident();incidents=[];incidentChoices=[];incidentPicking=false;incidentDirty=false;mission.setIncidents([]);node('incident-pick').setAttribute('aria-pressed','false');hooks.incidents([]);node('incident-results').replaceChildren();node('incident-status').textContent='No simulated incidents.'
    if(restore&&originalRoutes){const old=distance;hooks.routesUpdated(originalRoutes);setRoutes(originalRoutes);updateCursor(old)}
    originalRoutes=undefined
  }
  function addIncident(kind:'obstacle'|'gap',point?:{eastM:number;northM:number}){
    const route=routes[selected];if(!route)return
    const radius=Number(input('incident-radius').value)
    if(!Number.isFinite(radius)||radius<2||radius>30){node('incident-status').textContent='Choose an incident radius between 2 and 30 m.';return}
    const ahead=point??profileSample!(Math.min(route.metrics.distanceM,distance+Math.max(20,3*radius)))
    const current=profileSample!(distance)
    if(Math.hypot(ahead.eastM-current.eastM,ahead.northM-current.northM)<radius+3){node('incident-status').textContent='Place the incident farther from the current position. The complete crew footprint must remain outside it.';return}
    if(incidents.length>=12){node('incident-status').textContent='Reset the incident exercise before adding more than 12 marks.';return}
    cancel();stopIncident();hooks.pause();originalRoutes??=routes
    incidents.push({id:Date.now(),kind,eastM:ahead.eastM,northM:ahead.northM,radiusM:radius,reportedAtDistanceM:distance});mission.setIncidents(incidents);incidentDirty=true;incidentChoices=[]
    hooks.incidents(incidents);node('incident-results').replaceChildren()
    const crosses=profilePoints(route).some((p,i,a)=>i>0&&segmentTouchesIncident(a[i-1],p,incidents.at(-1)!))
    node('incident-status').textContent=`Simulated ${kind==='gap'?'coverage gap':'boulder field'} marked. ${crosses?'The displayed route crosses the new mark. Dashed pieces are unapproved.':'The mark does not cross this route.'} Compare detour / return before resuming.`
    showProfile(selected,false)
  }
  function renderIncidentChoices(){
    const host=node('incident-results');host.replaceChildren()
    for(const choice of incidentChoices){
      const card=document.createElement('article'),title=document.createElement('h3');title.textContent=choice.kind==='science'?'Detour to science, then rover':'Return to rover now';card.append(title)
      const detail=document.createElement('p')
      if(!choice.route){detail.textContent=choice.error??'No checked route found.';card.append(detail);host.append(card);continue}
      const remainingPeak=profilePoints(choice.route).filter(p=>p.cumulativeDistanceM>distance).reduce((n,p)=>Math.max(n,Math.abs(p.segmentGradeDeg)),0)
      detail.textContent=`${(choice.route.metrics.distanceM-distance).toFixed(1)} m remaining · ${remainingPeak.toFixed(2)}° steepest section ahead.`
      card.append(detail)
      const button=document.createElement('button');button.textContent=choice.kind==='science'?'Use science detour':'Use return route'
      button.addEventListener('click',()=>{
        if(!choice.route)return
        hooks.pause();incidentDirty=false;hooks.routesUpdated([choice.route]);setRoutes([choice.route]);updateCursor(choice.route.completedDistanceM??distance)
        node('incident-status').textContent=`${choice.route.name} selected. Completed travel is preserved. All future pieces passed the current incident and crew checks.`
        node('selected-route-proof').textContent='Incident repair: checked Field D* crew route, not the continuous optimizer. No continuous global bound or independent source audit.'
        node('incident-results').replaceChildren();incidentChoices=[]
      });card.append(button);host.append(card)
    }
  }
  function replanIncident(){
    const route=routes[selected];if(!route||!config)return
    if(!config.crewModel){node('incident-status').textContent='Choose crew planning or the continuous planner for a crew-clearance incident check.';return}
    const cap=Number(input('incident-grade').value)
    if(!Number.isFinite(cap)||cap<=0||cap>config.rules.moveGradeLimitDeg){node('incident-status').textContent=`Choose a positive incident walking-grade cap up to ${config.rules.moveGradeLimitDeg}°.`;return}
    stopIncident();hooks.pause();cancel();const id=incidentGeneration
    incidentWorker=new IncidentWorker();node('incident-cancel').hidden=false;node('incident-status').textContent='Checking detour and return from this exact route position…'
    incidentWorker.onmessage=({data}:MessageEvent<IncidentMessage>)=>{
      if(data.id!==incidentGeneration)return
      if(data.type==='progress'){node('incident-status').textContent=data.text;return}
      if(data.type==='error'){stopIncident();node('incident-status').textContent=data.text;return}
      stopIncident();incidentChoices=data.choices;renderIncidentChoices();node('incident-status').textContent='Choices checked. Select a route to continue; failed searches do not establish that no continuous route exists.'
    }
    incidentWorker.onerror=()=>{stopIncident();node('incident-status').textContent='Incident search failed. The previous route is retained.'}
    incidentTimer=setTimeout(()=>{stopIncident();node('incident-status').textContent='Incident search reached two minutes. The current route is retained.'},120000)
    incidentWorker.postMessage({id,grid,config,route,distanceM:distance,incidents,gradeCapDeg:cap})
  }
  input('incident-grade').addEventListener('input',()=>{stopIncident();incidentChoices=[];node('incident-results').replaceChildren();if(incidents.length){incidentDirty=true;hooks.pause()}node('incident-status').textContent='Grade cap changed. Recompute detour / return before choosing a route.'})
  node('incident-obstacle').addEventListener('click',()=>addIncident('obstacle'))
  node('incident-gap').addEventListener('click',()=>addIncident('gap'))
  node('incident-pick').addEventListener('click',()=>{hooks.pause();incidentPicking=!incidentPicking;node('incident-pick').setAttribute('aria-pressed',String(incidentPicking));if(incidentPicking){hooks.briefing();node('incident-status').textContent='Tap the terrain to mark a simulated boulder field.'}})
  node('incident-replan').addEventListener('click',replanIncident)
  node('incident-cancel').addEventListener('click',()=>{stopIncident();node('incident-status').textContent='Incident search cancelled; the current route is retained.'})
  node('incident-clear').addEventListener('click',()=>resetIncidents())
  for(const slot of ['A','B'] as const)node(`save-dropoff-${slot.toLowerCase()}`).addEventListener('click',()=>{if(!config||!previewCandidate())return;dropoffs[slot]={...candidate()};node('dropoff-status').textContent=`${['A','B'].map(k=>{const p=dropoffs[k as 'A'|'B'];return p?`${k}: ${p.row}, ${p.column}`:`${k}: not saved`}).join(' · ')}`})
  node('compare-dropoffs').addEventListener('click',async()=>{
    if(!dropoffs.A||!dropoffs.B){node('dropoff-status').textContent='Save both drop-off candidates first.';return}
    if(dropoffs.A.row===dropoffs.B.row&&dropoffs.A.column===dropoffs.B.column){node('dropoff-status').textContent='A and B are the same point. Save a different candidate for B.';return}
    cancel();hooks.pause();const id=generation.next(),options=continuousOptions();dropoffPlans=[];node('dropoff-results').replaceChildren();node('cancel-search').hidden=false
    form.setAttribute('aria-busy','true')
    try{
      for(const slot of ['A','B'] as const){node('dropoff-status').textContent=`Calculating drop-off ${slot} with the same route limits…`;const plan=await requestContinuous(id,dropoffs[slot]!,options);if(!generation.current(id))return;dropoffPlans.push(plan)}
      stop();const host=node('dropoff-results'),table=document.createElement('table');table.innerHTML='<thead><tr><th>Drop-off</th><th>Round trip</th><th>Peak grade</th><th>Climb</th><th>Time + sampling</th><th>Exposure</th><th>Choose</th></tr></thead>'
      const body=document.createElement('tbody')
      dropoffPlans.forEach((plan,i)=>{const route=plan.routes[0],t=createTiming(route,mission.scenario),row=document.createElement('tr');for(const value of [i?'B':'A',`${route.metrics.distanceM.toFixed(1)} m`,`${route.metrics.maxAbsGradeDeg.toFixed(2)}°`,`${route.metrics.positiveClimbM.toFixed(1)} m`,minutes(t.totalS),mission.scenario.enabled?`${(t.totalS/3600*mission.scenario.doseRateUSvH).toFixed(2)} µSv`:'Unavailable']){const cell=document.createElement('td');cell.textContent=value;row.append(cell)}const cell=document.createElement('td'),button=document.createElement('button');button.textContent=`Use ${i?'B':'A'}`;button.addEventListener('click',()=>{resetIncidents(false);applyPlan(plan,plan.config!,{...plan,environmentalScenario:mission.scenario})});cell.append(button);row.append(cell);body.append(row)});table.append(body);host.append(table)
      node('dropoff-status').textContent='Both drop-offs independently checked with identical limits. Select one to load its mission.'
      message('Drop-off comparison ready. The current mission is retained until you choose A or B.')
    }catch(error){if(generation.current(id)){stop();node('dropoff-status').textContent=error instanceof Error?error.message:'Drop-off comparison failed.';message('Drop-off comparison did not finish; current mission retained.')}}
  })
  function exportRecord(){
    if(download)URL.revokeObjectURL(download)
    const incident=routes.some(r=>r.name)
    const record={...lastRecord,schemaVersion:2,status:incidentDirty?'unapproved-proposed-route':incident?'incident-future-engine-checked':'mission-snapshot',validForCurrentIncidents:!incidentDirty,independentAudit:incident||incidentDirty?false:lastRecord.independentAudit??null,missionId:continuousMissionId??grid.datasetVersion,datasetVersion:grid.datasetVersion,config,routes,selectedRoute:selected,distanceM:distance,environmentalScenario:mission.scenario,incidents,completedDistanceM:routes[selected]?.completedDistanceM??0,notes:incidentDirty?'A new incident has invalidated the proposed future route. Replanning is required; any original audit applies only to the unmodified source terrain.':incident?'Completed geometry is history. Future geometry was checked against current incidents by the crew engine; no independent audit or continuous bound.':'Environmental values are assumptions. Original route provenance is retained in the package or comparison evidence.'}
    download=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}))
    const link=node('live-download') as HTMLAnchorElement;link.href=download
    return download
  }
  node('live-download').addEventListener('click',()=>exportRecord())
  node('export-mission').addEventListener('click',()=>{if(!routes.length)return;const link=document.createElement('a');link.href=exportRecord();link.download='marekh-mission.json';link.click()})
  return {
    cancel,
    get scenario(){return mission.scenario},get selectedIndex(){return selected},
    seek:updateCursor,
    get canPlay(){return !incidentDirty},resetSampling:()=>mission.resetSampling(),
    sample:(value:number)=>mission.sample(value),
    routeAt:()=>routes[selected],
    markIncident(eastM:number,northM:number){if(!incidentPicking)return false;incidentPicking=false;node('incident-pick').setAttribute('aria-pressed','false');addIncident('obstacle',{eastM,northM});return true},
    inspectRoute(eastM:number,northM:number,toleranceM=6){
      const route=routes[selected];if(!route)return false
      const points=profilePoints(route);let best=Infinity,bestDistance=0
      for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],dx=b.eastM-a.eastM,dy=b.northM-a.northM,l=dx*dx+dy*dy,t=l?Math.max(0,Math.min(1,((eastM-a.eastM)*dx+(northM-a.northM)*dy)/l)):0,d=Math.hypot(eastM-a.eastM-t*dx,northM-a.northM-t*dy);if(d<best-1e-8||Math.abs(d-best)<1e-8&&Math.abs(a.cumulativeDistanceM+t*(b.cumulativeDistanceM-a.cumulativeDistanceM)-distance)<Math.abs(bestDistance-distance)){best=d;bestDistance=a.cumulativeDistanceM+t*(b.cumulativeDistanceM-a.cumulativeDistanceM)}}
      if(best>toleranceM)return false;hooks.pause();updateCursor(bestDistance);return true
    },
    chooseCell(cell:Cell){if(!picking)return false;cancel();picking=false;node('pick-start').setAttribute('aria-pressed','false');input('start-row').value=String(cell.row);input('start-column').value=String(cell.column);previewCandidate();return true},
    saved(next:InspectableRoute[],nextConfig:PlanningConfig,nextMode:typeof mode,hazard?:Uint8Array){cancel();resetIncidents(false);cacheKey='';continuousCache=[];lastRecord={status:'saved-package',independentAudit:true,navigationModel:nextMode};config=nextConfig;mode=nextMode;stagingHazard=hazard;activeStart={...config.staging.cell};input('start-row').value=String(activeStart.row);input('start-column').value=String(activeStart.column);input('start-row').setAttribute('aria-invalid','false');input('start-column').setAttribute('aria-invalid','false');node('live-download').hidden=true;hooks.candidate(undefined);refreshMode();setRoutes(next);message(mode==='global'?'Saved route ready. Choose a different start to plan a new walk.':'Saved route ready. Choose a different start to plan a new walk.','current')},
  }
}
