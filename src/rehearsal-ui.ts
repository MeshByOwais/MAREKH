import {RehearsalPlayback,createRouteTrack,type RehearsalMode,type RouteFrame} from './mission/rehearsal.ts'
import type {ProfileRoute,ProfileSample} from './routing/profile.ts'

const node=(id:string)=>document.getElementById(id)!
const input=(id:string)=>node(id) as HTMLInputElement
export function createRehearsalUI(hooks:{seek(distance:number):void;sample(distance:number):ProfileSample|undefined;canPlay():boolean;replay():void;mode(mode:RehearsalMode):void;pose(mode:RehearsalMode,frame:RouteFrame):void}){
  let playback:RehearsalPlayback|undefined,track:ReturnType<typeof createRouteTrack>|undefined,mode:RehearsalMode='briefing'
  let frameId:number|undefined,lastTime:number|undefined,publishing=false
  const motion=matchMedia('(prefers-reduced-motion: reduce)')
  input('reduced-motion').checked=motion.matches
  function stopFrames(){if(frameId!==undefined)cancelAnimationFrame(frameId);frameId=undefined;lastTime=undefined}
  function render(){
    if(!playback||!track)return
    const sample=hooks.sample(playback.distanceM)??track(playback.distanceM).sample,reduced=input('reduced-motion').checked
    const isScience=playback.stage==='science'
    node('rehearsal-panel').hidden=false
    node('rehearsal-hud').hidden=mode==='briefing'
    for(const key of ['briefing','flyover','helmet'])node(`mode-${key}`).setAttribute('aria-pressed',String(key===mode))
    ;(node('preview-play') as HTMLButtonElement).disabled=reduced||playback.totalM===0||mode==='briefing'||!hooks.canPlay()
    ;(node('preview-quick-play') as HTMLButtonElement).disabled=reduced||playback.totalM===0||mode==='briefing'||!hooks.canPlay()
    node('preview-play').textContent=playback.playing?'Pause preview':isScience?'Continue return':playback.stage==='complete'?'Play again':'Play preview'
    node('preview-quick-play').textContent=playback.playing?'Pause':isScience?'Return':playback.stage==='complete'?'Replay':'Play'
    node('preview-quick-play').setAttribute('aria-label',node('preview-play').textContent!)
    node('rehearsal-distance').textContent=`${playback.distanceM.toFixed(2)} / ${playback.totalM.toFixed(2)} m · ${sample.leg}`
    input('rehearsal-distance-slider').max=String(playback.totalM);input('rehearsal-distance-slider').value=String(playback.distanceM)
    input('rehearsal-distance-slider').setAttribute('aria-valuetext',`${playback.distanceM.toFixed(2)} metres, ${sample.leg}`)
    const message=playback.stage==='complete'?'Back at the rover. The round trip is complete.':isScience?'Reached the science stop. Choose Continue return when ready.':reduced?'Reduced motion is on. Use the distance slider or step controls.':playback.playing?(playback.distanceM<playback.turnaroundM?'Preview playing. It will pause at the science approach.':'Preview playing. Returning to the rover.'):mode==='briefing'?'Choose Follow route for an overhead preview or Crew view to see the walk at eye level.':'Preview paused. Move the distance slider or choose Play preview.'
    if(node('rehearsal-status').textContent!==message)node('rehearsal-status').textContent=message
    node('science-stop-card').hidden=!isScience
    node('rehearsal-hud-mode').textContent=`${mode==='helmet'?'Crew view':mode==='flyover'?'Follow route':'Map'} · ${sample.leg}`
    node('rehearsal-hud-distance').textContent=`${playback.distanceM.toFixed(1)} / ${playback.totalM.toFixed(1)} m`
    node('rehearsal-next').textContent=playback.stage==='complete'?'Back at the rover':sample.distanceM<playback.turnaroundM-1e-6?`Science stop · ${(playback.turnaroundM-playback.distanceM).toFixed(1)} m along route`:isScience?'Science stop · preview paused':`Return to rover · ${(playback.totalM-playback.distanceM).toFixed(1)} m along route`
    const missing='conditions' in sample&&!!(sample.conditions as {coverageUnavailable?:boolean}).coverageUnavailable
    node('rehearsal-grade').textContent=missing?'Terrain detail unavailable · proposed route requires repair':`Walking grade ${sample.segmentGradeDeg.toFixed(2)}° · surface ${sample.edgeSurfaceSlopeDeg.toFixed(2)}°`
    node('rehearsal-alert').textContent=sample.reasons.length?sample.reasons.join(' '):'No terrain or scenario alert at this point.'
    node('rehearsal-alert').classList.toggle('alert-reading',sample.reasons.length>0)
  }
  function pose(){if(playback&&track&&mode!=='briefing')hooks.pose(mode,track(playback.distanceM))}
  function publish(){if(!playback)return;publishing=true;try{hooks.seek(playback.distanceM)}finally{publishing=false}pose();render()}
  function pause(){playback?.pause();stopFrames();render()}
  function seek(distance:number){if(!playback)return;stopFrames();playback.seek(distance);publish()}
  function setMode(next:RehearsalMode){
    if(!playback)return
    pause();mode=next;hooks.mode(mode);pose();render()
  }
  function tick(now:number){
    frameId=undefined;if(!playback?.playing||input('reduced-motion').checked||document.hidden||!hooks.canPlay()){pause();return}
    const delta=lastTime===undefined?0:Math.min(.1,Math.max(0,(now-lastTime)/1000));lastTime=now
    playback.advance(delta,Number((node('preview-speed') as HTMLSelectElement).value));publish()
    if(playback.playing)frameId=requestAnimationFrame(tick);else stopFrames()
  }
  function play(){
    if(!playback||mode==='briefing'||input('reduced-motion').checked||!hooks.canPlay())return
    if(playback.playing){pause();return}
    if(playback.stage==='complete')hooks.replay()
    playback.play();render();node('terrain-view').scrollIntoView({block:'center',behavior:'instant'});frameId=requestAnimationFrame(tick)
  }
  for(const key of ['briefing','flyover','helmet'] as const)node(`mode-${key}`).addEventListener('click',()=>setMode(key))
  node('preview-play').addEventListener('click',play)
  node('preview-quick-play').addEventListener('click',play)
  node('preview-replay').addEventListener('click',()=>{stopFrames();hooks.replay();playback?.replay();publish()})
  node('preview-exit').addEventListener('click',()=>{setMode('briefing');node('mode-briefing').focus()})
  node('preview-back').addEventListener('click',()=>seek((playback?.distanceM??0)-5))
  node('preview-forward').addEventListener('click',()=>seek((playback?.distanceM??0)+5))
  node('preview-science').addEventListener('click',()=>seek(playback?.turnaroundM??0))
  node('preview-finish').addEventListener('click',()=>seek(playback?.totalM??0))
  input('rehearsal-distance-slider').addEventListener('input',()=>seek(Number(input('rehearsal-distance-slider').value)))
  input('reduced-motion').addEventListener('change',pause)
  motion.addEventListener('change',event=>{input('reduced-motion').checked=event.matches;pause()})
  document.addEventListener('visibilitychange',()=>{if(document.hidden)pause()})
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&mode!=='briefing'){setMode('briefing');node('mode-briefing').focus()}})
  return {
    get mode(){return mode},pause,continueReturn(){if(mode==='briefing')setMode('flyover');if(!playback?.playing)play()},
    exit(){if(mode!=='briefing')setMode('briefing')},
    setRoute(route:ProfileRoute,warningDeg:number){node('preview-science').textContent=route.scienceStop===false?'Return decision':'Science stop';pause();if(mode!=='briefing'&&route.completedDistanceM===undefined)setMode('briefing');playback=new RehearsalPlayback(route.metrics.distanceM,route.turnaroundDistanceM,route.scienceStop!==false);if(route.completedDistanceM)playback.seek(route.completedDistanceM);track=createRouteTrack(route,warningDeg);if(mode!=='briefing')hooks.mode(mode);pose();render();node('rehearsal-view-controls').hidden=false},
    cursor(sample:ProfileSample){if(!playback||publishing)return;stopFrames();playback.seek(sample.distanceM);pose();render()},
  }
}
