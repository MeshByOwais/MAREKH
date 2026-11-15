// Reuse the existing controls in a compact workspace; planning state stays intact.
const main=document.querySelector('main')!
const scene=document.querySelector<HTMLElement>('.scene-layout')!
const terrain=scene.querySelector<HTMLElement>(':scope > section')!
const sidebar=document.createElement('section');sidebar.className='workspace-sidebar';sidebar.setAttribute('aria-label','Mission tools')
const dashboard=document.createElement('div');dashboard.className='mission-workspace'
const tabs=document.createElement('div');tabs.className='workspace-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Workspace sections')
const panes=document.createElement('div');panes.className='workspace-panes'
const sections=[['plan','Plan'],['routes','Routes'],['rehearse','Rehearse'],['conditions','Conditions'],['more','Mission']] as const
const panels=new Map<string,HTMLElement>()
for(const [id,label] of sections){
 const button=document.createElement('button');button.id=`tab-${id}`;button.type='button';button.textContent=label;button.setAttribute('role','tab');button.setAttribute('aria-controls',`pane-${id}`)
 const panel=document.createElement('div');panel.id=`pane-${id}`;panel.className='workspace-pane';panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',button.id);panel.tabIndex=0
 tabs.append(button);panes.append(panel);panels.set(id,panel)
}
const mapTab=document.createElement('button');mapTab.type='button';mapTab.className='mobile-map-tab';mapTab.textContent='Map';mapTab.setAttribute('aria-label','Show terrain map');tabs.prepend(mapTab)
function showWorkspaceTab(id:string){
 for(const [key,panel] of panels){panel.hidden=key!==id;const button=document.getElementById(`tab-${key}`)!;button.setAttribute('aria-selected',String(key===id));button.tabIndex=key===id?0:-1}
 dashboard.dataset.mobileView='tools';mapTab.setAttribute('aria-pressed','false')
}
// Bind after attachment so tab state can use stable document IDs.
sidebar.append(tabs,panes);dashboard.append(sidebar,scene);main.prepend(dashboard)
for(const [id] of sections)document.getElementById(`tab-${id}`)!.addEventListener('click',()=>showWorkspaceTab(id))
tabs.addEventListener('keydown',event=>{
 if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return
 const buttons=sections.map(([id])=>document.getElementById(`tab-${id}`)!)
 const index=buttons.indexOf(document.activeElement as HTMLElement);if(index<0)return
 event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length
 showWorkspaceTab(sections[next][0]);buttons[next].focus()
})
function move(selector:string,pane:string){const node=document.querySelector(selector);if(node)panels.get(pane)!.append(node)}
move('.live-planning','plan');move('.incident-panel','rehearse');move('#rehearsal-panel','rehearse')
move('.route-comparison','routes');move('#route-profile-panel','routes');move('#scenario-settings','conditions')
move('.mission-hero','more');move('.discovery-strip','more')
for(const node of Array.from(main.querySelectorAll(':scope > details')))panels.get('more')!.append(node)
const inspect=scene.querySelector('aside > details');if(inspect)panels.get('more')!.append(inspect)
scene.querySelector('aside')?.remove()
const strip=document.querySelector('.mission-strip');if(strip)terrain.prepend(strip)
for(const id of ['mission-turnback','mission-decision']){const node=document.getElementById(id);if(node)panels.get('conditions')!.prepend(node)}
const rehearsalPanel=document.getElementById('rehearsal-panel')!;panels.get('rehearse')!.prepend(rehearsalPanel)
const scenario=document.getElementById('scenario-settings') as HTMLDetailsElement;scenario.open=true
showWorkspaceTab('plan')
function showMap(){dashboard.dataset.mobileView='map';mapTab.setAttribute('aria-pressed','true')}
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
element('mars-globe').addEventListener('click',()=>{element('mars-globe').classList.toggle('spinning')})
element('focus-workspace').addEventListener('click',()=>{
 const focused=document.body.classList.toggle('workspace-focus')
 element('focus-workspace').setAttribute('aria-pressed',String(focused))
 element('focus-workspace').textContent=focused?'Exit focus ↙':'Focus mode ↗'
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

// Delegation also covers route and incident actions created after a new search.
document.addEventListener('click',event=>{
 if(matchMedia('(prefers-reduced-motion: reduce)').matches)return
 const target=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button.primary'):null
 if(!target||target.disabled||target.closest('fieldset:disabled')||target.id==='mars-globe')return
 const box=target.getBoundingClientRect(),wave=document.createElement('span')
 wave.className='click-wave';wave.setAttribute('aria-hidden','true')
 wave.style.left=`${event.detail?(event as MouseEvent).clientX-box.left:box.width/2}px`
 wave.style.top=`${event.detail?(event as MouseEvent).clientY-box.top:box.height/2}px`
 target.append(wave)
 wave.addEventListener('animationend',()=>wave.remove(),{once:true})
 setTimeout(()=>wave.remove(),700)
})

// One occasional supply run; decorative and never an obstacle to map interaction.
const rocket=document.createElement('div')
rocket.className='supply-rocket';rocket.setAttribute('aria-hidden','true')
rocket.innerHTML=`<svg viewBox="0 0 160 64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="rocket-metal" x2="0" y2="1"><stop stop-color="#e2e7e8"/><stop offset="1" stop-color="#94a7b3"/></linearGradient><linearGradient id="rocket-flame"><stop stop-color="#f0a05b" stop-opacity="0"/><stop offset=".75" stop-color="#efb775"/><stop offset="1" stop-color="#ffe3b5"/></linearGradient></defs><path class="rocket-flame" d="M4 32Q25 19 59 26L59 38Q26 45 4 32" fill="url(#rocket-flame)"/><path d="M59 24L49 10L79 17M59 40L49 54L79 47" fill="#c77b51"/><path d="M54 24Q105 6 139 32Q105 58 54 40Z" fill="url(#rocket-metal)"/><path d="M118 21Q131 24 139 32Q131 40 118 43Z" fill="#d5895c"/><circle cx="98" cy="32" r="9" fill="#283f50" stroke="#7897a6" stroke-width="3"/><path d="M94 28L100 26" stroke="#c5dce5" stroke-width="2" stroke-linecap="round"/><path d="M57 26L57 38" stroke="#526b79" stroke-width="5"/></svg><span class="rocket-caption">Important cargo: snacks.</span>`
document.body.append(rocket)
let rocketFlying=false,lastFlight=-20000,scrollTravel=0,lastScroll=scrollY
function launchSupply(){
 if(rocketFlying)return
 if(matchMedia('(prefers-reduced-motion: reduce)').matches){
  const button=element('launch-rocket');button.textContent='✓ Snacks dispatched'
  setTimeout(()=>{button.textContent='↗ Send snacks to Mars'},2400);return
 }
 rocketFlying=true;lastFlight=Date.now();rocket.classList.add('in-flight')
 element('launch-rocket').setAttribute('aria-pressed','true')
}
rocket.addEventListener('animationend',event=>{if(event.target!==rocket)return;rocket.classList.remove('in-flight');rocketFlying=false;element('launch-rocket').setAttribute('aria-pressed','false')})
element('launch-rocket').addEventListener('click',launchSupply)
window.addEventListener('scroll',()=>{
 scrollTravel+=Math.abs(scrollY-lastScroll);lastScroll=scrollY
 if(scrollTravel>650&&Date.now()-lastFlight>18000&&element('mission-map').dataset.mode!=='helmet'&&element('mission-map').dataset.mode!=='flyover'&&!document.body.classList.contains('workspace-focus')&&!matchMedia('(prefers-reduced-motion: reduce)').matches){scrollTravel=0;launchSupply()}
},{passive:true})

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
