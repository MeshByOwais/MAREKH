// Reuse the existing controls in a compact workspace; planning state stays intact.
const main=document.querySelector('main')!
const scene=document.querySelector<HTMLElement>('.scene-layout')!
const terrain=scene.querySelector<HTMLElement>(':scope > section')!
const sidebar=document.createElement('section');sidebar.className='workspace-sidebar';sidebar.setAttribute('aria-label','Mission tools')
const dashboard=document.createElement('div');dashboard.className='mission-workspace'
const tabs=document.createElement('div');tabs.className='workspace-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Workspace sections')
const panes=document.createElement('div');panes.className='workspace-panes'
const sections=[['plan','Plan'],['routes','Routes'],['rehearse','Preview'],['conditions','Time'],['more','More']] as const
const panels=new Map<string,HTMLElement>()
for(const [id,label] of sections){
 const button=document.createElement('button');button.id=`tab-${id}`;button.type='button';button.textContent=label;button.setAttribute('role','tab');button.setAttribute('aria-controls',`pane-${id}`);if(id==='conditions')button.hidden=true
 const panel=document.createElement('div');panel.id=`pane-${id}`;panel.className='workspace-pane';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);panel.tabIndex=0
 tabs.append(button);panes.append(panel);panels.set(id,panel)
}
const mapTab=document.createElement('button');mapTab.type='button';mapTab.className='mobile-map-tab';mapTab.textContent='Map';mapTab.setAttribute('aria-label','Show terrain map');mapTab.setAttribute('role','tab');mapTab.setAttribute('aria-controls','terrain-panel');scene.id='terrain-panel';tabs.prepend(mapTab)
function showWorkspaceTab(id:string){
 for(const [key,panel] of panels){panel.hidden=key!==id;const button=document.getElementById(`tab-${key}`)!;button.setAttribute('aria-selected',String(key===id));button.tabIndex=key===id?0:-1}
 dashboard.dataset.mobileView='tools';mapTab.setAttribute('aria-pressed','false');mapTab.setAttribute('aria-selected','false');mapTab.tabIndex=-1
}
// Bind after attachment so tab state can use stable document IDs.
sidebar.append(tabs,panes);dashboard.append(sidebar,scene);main.prepend(dashboard)
for(const [id] of sections)document.getElementById(`tab-${id}`)!.addEventListener('click',()=>showWorkspaceTab(id))
tabs.addEventListener('keydown',event=>{
 if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
 const visibleSections=sections.filter(([id])=>id!=='conditions')
 const buttons=visibleSections.map(([id])=>document.getElementById(`tab-${id}`)!)
 if(matchMedia('(max-width: 850px)').matches)buttons.unshift(mapTab)
 const index=buttons.indexOf(document.activeElement as HTMLElement);if(index<0)return
 event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length
 if(buttons[next]===mapTab)showMap();else showWorkspaceTab(buttons[next].id.replace('tab-',''));buttons[next].focus()
})
function move(selector:string,pane:string){const node=document.querySelector(selector);if(node)panels.get(pane)!.append(node)}
move('.live-planning','plan');move('.incident-panel','rehearse');move('#rehearsal-panel','rehearse')
move('.route-comparison','routes');move('#route-profile-panel','routes');move('#scenario-settings','conditions')
move('.mission-hero','more');move('.discovery-strip','more')
for(const node of Array.from(main.querySelectorAll(':scope > details')))panels.get('more')!.append(node)
const inspect=scene.querySelector('aside > details');if(inspect)panels.get('more')!.append(inspect)
scene.querySelector('aside')?.remove()
const strip=document.querySelector('.mission-strip');if(strip)terrain.prepend(strip)
const extraTimes=document.createElement('div');extraTimes.className='extra-times'
if(strip)for(const card of Array.from(strip.children).slice(2))extraTimes.append(card)
panels.get('conditions')!.prepend(extraTimes)
const coordinateDetails=document.createElement('details');coordinateDetails.className='quiet-details start-coordinates'
const coordinateSummary=document.createElement('summary');coordinateSummary.textContent='Enter grid coordinates instead'
const coordinates=document.createElement('div');coordinates.className='coordinate-fields'
for(const id of ['start-row','start-column'])coordinates.append(document.getElementById(id)!.closest('label')!)
coordinateDetails.append(coordinateSummary,coordinates)
document.getElementById('find-staging')!.after(coordinateDetails)
const sourceLink=document.getElementById('source-review-nav');if(sourceLink)panels.get('more')!.append(sourceLink)

for(const id of ['mission-turnback','mission-decision']){const node=document.getElementById(id);if(node)panels.get('conditions')!.prepend(node)}
const rehearsalPanel=document.getElementById('rehearsal-panel')!;panels.get('rehearse')!.prepend(rehearsalPanel)
const scenario=document.getElementById('scenario-settings') as HTMLDetailsElement;scenario.open=true
showWorkspaceTab('plan')
function showMap(){
 dashboard.dataset.mobileView='map';mapTab.setAttribute('aria-pressed','true');mapTab.setAttribute('aria-selected','true');mapTab.tabIndex=0
 if(matchMedia('(max-width: 850px)').matches)for(const [id] of sections){const button=document.getElementById(`tab-${id}`)!;button.setAttribute('aria-selected','false');button.tabIndex=-1}
}
mapTab.addEventListener('click',showMap)
if(matchMedia('(max-width: 850px)').matches)showMap()
for(const id of ['pick-start','incident-pick'])document.getElementById(id)!.addEventListener('click',showMap)
for(const id of ['explore-map','launch-helmet','jump-science'])document.getElementById(id)!.addEventListener('click',showMap)
for(const id of ['mode-flyover','mode-helmet'])document.getElementById(id)!.addEventListener('click',()=>{if(!matchMedia('(max-width: 850px)').matches)showWorkspaceTab('rehearse')})

const element=(id:string)=>document.getElementById(id)!
const map=()=>element('mission-map').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'center'})
element('explore-map').addEventListener('click',map)
element('launch-helmet').addEventListener('click',()=>{element('mode-helmet').click();map()})
element('jump-science').addEventListener('click',()=>{element('go-turnaround').click();map()})
element('focus-workspace').addEventListener('click',()=>{
 const focused=document.body.classList.toggle('workspace-focus')
 element('focus-workspace').setAttribute('aria-pressed',String(focused))
 element('focus-workspace').textContent=focused?'Exit focus':'Focus mode'
 if(focused)map()
})
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('workspace-focus'))element('focus-workspace').click()})
// Match the underlying planner's readiness instead of offering inactive shortcuts.
const ready=new MutationObserver(()=>{
 const available=!element('rehearsal-view-controls').hidden
 for(const id of ['launch-helmet','jump-science'])(element(id) as HTMLButtonElement).disabled=!available
})
ready.observe(element('rehearsal-view-controls'),{attributes:true,attributeFilter:['hidden']})
for(const id of ['launch-helmet','jump-science'])(element(id) as HTMLButtonElement).disabled=!!element('rehearsal-view-controls').hidden

// A sparse, uneven sky: mostly faint stars, with only a few slow variations.
const sky=document.createElement('div')
sky.className='space-sky';sky.setAttribute('aria-hidden','true')
let starSeed=7031
const random=()=>{starSeed=(starSeed*16807)%2147483647;return (starSeed-1)/2147483646}
for(let i=0;i<95;i++){
 const star=document.createElement('i'),bright=i%17===0
 star.className=bright?'sky-star luminous':'sky-star'
 star.style.cssText=`left:${(random()*100).toFixed(2)}%;top:${(random()*100).toFixed(2)}%;--star-size:${bright?1.8:(.6+random()*.7).toFixed(2)}px;--star-opacity:${(.18+random()*.38).toFixed(2)};--star-delay:${(-random()*20).toFixed(1)}s;--star-duration:${(9+random()*12).toFixed(1)}s`
 sky.append(star)
}
document.body.prepend(sky)

const readoutToggle=document.createElement('button')
readoutToggle.type='button';readoutToggle.className='map-readout-toggle';readoutToggle.textContent='Hide readings'
readoutToggle.setAttribute('aria-pressed','false');readoutToggle.setAttribute('aria-label','Hide map readings')
readoutToggle.setAttribute('aria-controls','rehearsal-hud target-labels')
element('mission-map').append(readoutToggle)
readoutToggle.addEventListener('click',()=>{
 const hidden=element('mission-map').classList.toggle('readouts-hidden')
 readoutToggle.textContent=hidden?'Show readings':'Hide readings'
 readoutToggle.setAttribute('aria-label',hidden?'Show map readings':'Hide map readings')
 readoutToggle.setAttribute('aria-pressed',String(hidden))
})

for(const [id,help] of Object.entries({
 'pick-start':'Click a spot on the map to set the rover starting location.',
 'find-staging':'Find a nearby starting location that passes the terrain checks.',
 'compare-continuous':'Calculate both an easier route and a shorter route.',
 'mode-briefing':'Move around the map and inspect the route.',
 'mode-flyover':'Follow the route from above.',
 'mode-helmet':'Preview the walk at crew eye level.',
 'map-pan':'Drag to move across the ground.',
 'map-orbit':'Drag to rotate the camera around the terrain.',
 'export-mission':'Save the route, settings and current progress as a file.'
}))element(id).title=help

const startPrompt=document.createElement('div');startPrompt.className='map-selection-prompt';startPrompt.hidden=true
const startInstruction=document.createElement('span');startInstruction.textContent='Click the map to choose a start.'
const cancelStart=document.createElement('button');cancelStart.type='button';cancelStart.textContent='Cancel'
cancelStart.addEventListener('click',()=>element('pick-start').click())
startPrompt.append(startInstruction,cancelStart)
element('rehearsal-view-controls').before(startPrompt)
const syncStartPrompt=()=>{startPrompt.hidden=element('pick-start').getAttribute('aria-pressed')!=='true'}
new MutationObserver(syncStartPrompt).observe(element('pick-start'),{attributes:true,attributeFilter:['aria-pressed']})
syncStartPrompt()

// Retain hidden integration hooks without exposing the retired export action.

const legendList=document.querySelector('.legend')!
const legendPanel=legendList.parentElement!
const dataChecks=document.createElement('details');dataChecks.className='quiet-details'
const dataSummary=document.createElement('summary');dataSummary.textContent='Data checks';dataChecks.append(dataSummary)
for(const child of Array.from(legendPanel.children))if(child!==legendList&&child.tagName!=='SUMMARY')dataChecks.append(child)
legendPanel.append(dataChecks)

// Group camera manipulation separately from framing shortcuts.
const cameraControls=document.querySelector('.view-controls')!
for(const [label,ids] of [
 ['Drag mode',['map-pan','map-orbit']],
 ['Frame terrain',['home-view','route-view','full-view','north-view']]
] as const){
 const group=document.createElement('div');group.className='view-control-group';group.setAttribute('role','group');group.setAttribute('aria-label',label)
 for(const id of ids)group.append(element(id))
 cameraControls.append(group)
}
// Keep the active tool reachable when the workspace crosses its mobile breakpoint.
matchMedia('(max-width: 850px)').addEventListener('change',event=>{
 const selected=[...panels].find(([,panel])=>!panel.hidden)?.[0]||'plan'
 if(event.matches&&dashboard.dataset.mobileView==='map')showMap()
 else showWorkspaceTab(selected)
})
