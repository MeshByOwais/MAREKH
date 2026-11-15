import type { Cell, Grid } from './routing/planner.ts'
import { PlanningGeneration, type PlanningConfig, type LiveMode, type LivePlan, type LiveMessage } from './routing/interactive.ts'
import { profilePoints, sampleProfile, slopeAlerts, type ProfileRoute, type ProfileSample } from './routing/profile.ts'

export type InspectableRoute = ProfileRoute & {policy:string}
const node=(id:string)=>document.getElementById(id)!
const input=(id:string)=>node(id) as HTMLInputElement
export function createPlanningUI(grid:Grid, hooks:{
  live(plan:LivePlan,config:PlanningConfig):void; cursor(sample:ProfileSample):void
  choose(index:number):void; candidate(cell:Cell|undefined):void; searchStarted():void
}) {
  const generation=new PlanningGeneration()
  let worker:Worker|undefined,timer:ReturnType<typeof setTimeout>|undefined,config:PlanningConfig,mode:'global'|LiveMode='global'
  let routes:InspectableRoute[]=[],selected=0,distance=0,picking=false,download:string|undefined
  const status=node('placement-status'),form=node('start-form') as HTMLFormElement,slider=input('route-distance')
  function candidate() {
    const row=Number(input('start-row').value),column=Number(input('start-column').value)
    return {row:input('start-row').value===''?NaN:row,column:input('start-column').value===''?NaN:column}
  }
  function previewCandidate() {const p=candidate();hooks.candidate(Number.isInteger(p.row)&&Number.isInteger(p.column)?p:undefined)}
  function stop() {worker?.terminate();worker=undefined;if(timer)clearTimeout(timer);timer=undefined;node('cancel-search').hidden=true;form.removeAttribute('aria-busy')}
  function cancel(text?:string) {generation.next();stop();if(text)status.textContent=text}
  function label(route:InspectableRoute) {return route.policy==='shortest'?'Shortest':route.policy==='gentle'?'Gentler terrain':route.policy==='distance'?'Distance priority':route.policy==='terrain'?'Terrain priority':'Best grade candidate'}
  function updateCursor(value:number) {
    const route=routes[selected];if(!route)return
    distance=Math.max(0,Math.min(route.metrics.distanceM,value));slider.value=String(distance)
    const sample=sampleProfile(route,distance,config.rules.warningSlopeDeg)
    node('profile-distance').textContent=`${distance.toFixed(2)} / ${route.metrics.distanceM.toFixed(2)} m · ${sample.leg}`
    slider.setAttribute('aria-valuetext',`${distance.toFixed(2)} metres, ${sample.leg}`)
    node('profile-elevation').textContent=Number.isFinite(sample.elevationM)?`${sample.elevationM.toFixed(2)} m`:'Unavailable'
    node('profile-slope').textContent=Number.isFinite(sample.edgeSurfaceSlopeDeg)?`${sample.edgeSurfaceSlopeDeg.toFixed(2)}°`:'Unavailable'
    node('profile-grade').textContent=Number.isFinite(sample.segmentGradeDeg)?`${sample.segmentGradeDeg.toFixed(2)}°`:'Unavailable'
    node('profile-slope').classList.toggle('alert-reading',sample.reasons.length>0)
    node('profile-alert').textContent=sample.reasons.length?sample.reasons.join(' '):Number.isFinite(sample.edgeSurfaceSlopeDeg)?'No surface-slope warning at this point.':'Surface slope unavailable.'
    node('profile-alert').classList.toggle('alert-reading',sample.reasons.length>0)
    const cursor=node('profile-cursor'),x=40+920*(route.metrics.distanceM?distance/route.metrics.distanceM:0)
    cursor.setAttribute('x1',String(x));cursor.setAttribute('x2',String(x))
    hooks.cursor(sample)
  }
  function showProfile(index=0) {
    selected=index;const route=routes[index];if(!route)return
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
    hooks.choose(index);updateCursor(0)
  }
  function setRoutes(next:InspectableRoute[]) {
    routes=next;const select=node('route-choice') as HTMLSelectElement;select.replaceChildren()
    routes.forEach((r,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=label(r);select.append(option)})
    node('route-profile-panel').hidden=false
    const same=routes.length===2&&JSON.stringify(routes[0].outbound.points.map(p=>[p.eastM,p.northM]))===JSON.stringify(routes[1].outbound.points.map(p=>[p.eastM,p.northM]))
    node('policy-note').textContent=same?'Both policies produced the same path.':'Select a policy to inspect its profile and highlight it on the map.'
    showProfile()
  }
  function refreshMode() {
    const locked=mode==='global'
    ;(node('placement-fields') as HTMLFieldSetElement).disabled=locked
    node('live-start-help').textContent=locked?'This saved minimum-grade route has bounds for its original start. Choose NASA-informed crew planning or the A* baseline to move staging and compare live routes.':'Pick a cell on the map or enter its row and column. Plan both options after the full 10 × 10 m staging footprint passes the 5° limit. Live searches do not use the saved global-grade bounds or impose its 500 m budget.'
    if(locked){picking=false;node('pick-start').setAttribute('aria-pressed','false');hooks.candidate(undefined)}
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();if(mode==='global'||!config)return
    cancel();const id=generation.next(),start=candidate();hooks.searchStarted()
    if(!Number.isInteger(start.row)||!Number.isInteger(start.column)){status.textContent='Choose an integer row and column. The current plan is retained.';return}
    form.setAttribute('aria-busy','true');node('cancel-search').hidden=false;status.textContent='Starting background route search… The current plan remains visible.'
    const fail=(text:string)=>{if(!generation.current(id))return;stop();status.textContent=`${text} The current plan is retained.`}
    try {
      worker=new Worker(new URL('./routing/planning.worker.ts',import.meta.url),{type:'module'})
      worker.onmessage=({data}:MessageEvent<LiveMessage>)=>{
        if(!generation.current(data.id))return
        if(data.type==='progress'){status.textContent=data.text;return}
        if(data.type==='error'){fail(data.text);return}
        stop();hooks.live(data.plan,config);setRoutes(data.plan.routes)
        status.textContent=`Plan updated · start ${start.row}, ${start.column} · both policies checked on outbound and return.`
        hooks.candidate(undefined)
        if(download)URL.revokeObjectURL(download)
        download=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:1,status:'live-engine-checked',independentAudit:false,continuousOptimalityBounds:null,roundTripBudgetM:null,datasetVersion:grid.datasetVersion,mode,config:{...config,staging:{...config.staging,cell:data.plan.staging.cell}},staging:data.plan.staging,approach:data.plan.approach,routes:data.plan.routes},null,2)],{type:'application/json'}))
        const link=node('live-download') as HTMLAnchorElement;link.href=download;link.hidden=false
      }
      worker.onerror=()=>fail('The background planner could not complete the search.')
      timer=setTimeout(()=>fail('Search exceeded two minutes; try a closer staging point.'),120_000)
      worker.postMessage({id,grid,config,mode,start})
    } catch(error){fail(error instanceof Error?error.message:'The background planner is unavailable.')}
  })
  node('cancel-search').addEventListener('click',()=>cancel('Search cancelled. The current plan is retained.'))
  node('pick-start').addEventListener('click',()=>{picking=!picking;node('pick-start').setAttribute('aria-pressed',String(picking));status.textContent=picking?'Click the terrain to select a candidate cell, then choose Plan both routes.':'Map clicks inspect terrain.'})
  for(const id of ['start-row','start-column'])input(id).addEventListener('input',()=>{cancel('Candidate changed. Choose Plan both routes to apply it.');previewCandidate()})
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
    chooseCell(cell:Cell){if(!picking||mode==='global')return false;cancel();picking=false;node('pick-start').setAttribute('aria-pressed','false');input('start-row').value=String(cell.row);input('start-column').value=String(cell.column);previewCandidate();status.textContent=`Candidate cell ${cell.row}, ${cell.column}. Choose Plan both routes to check and apply it.`;return true},
    saved(next:InspectableRoute[],nextConfig:PlanningConfig,nextMode:typeof mode){cancel();config=nextConfig;mode=nextMode;input('start-row').value=String(config.staging.cell.row);input('start-column').value=String(config.staging.cell.column);node('live-download').hidden=true;hooks.candidate(undefined);refreshMode();setRoutes(next);status.textContent=mode==='global'?'Saved grade candidate loaded. Its bounds apply to this staging point.':'Saved plan loaded. Choose another staging cell to try a new walk.'},
  }
}
