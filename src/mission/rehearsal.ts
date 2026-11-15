import {createProfileSampler,profilePoints,type ProfileRoute,type ProfileSample} from '../routing/profile.ts'

export type RehearsalMode='briefing'|'flyover'|'helmet'
export type PlaybackStage='ready'|'playing'|'paused'|'science'|'complete'

/** Distance is the only mission clock. Preview speed is not walking speed. */
export class RehearsalPlayback {
  distanceM=0
  playing=false
  stage:PlaybackStage='ready'
  private visitedScience=false
  constructor(readonly totalM:number,readonly turnaroundM:number){
    if(!Number.isFinite(totalM)||!Number.isFinite(turnaroundM)||totalM<0||turnaroundM<0||turnaroundM>totalM)throw new Error('Invalid rehearsal distances')
  }
  seek(distance:number){
    if(!Number.isFinite(distance))throw new Error('Rehearsal distance must be finite')
    this.distanceM=Math.max(0,Math.min(this.totalM,distance));this.playing=false
    this.visitedScience=this.distanceM>=this.turnaroundM
    this.stage=this.distanceM>=this.totalM?'complete':Math.abs(this.distanceM-this.turnaroundM)<1e-6?'science':this.distanceM===0?'ready':'paused'
  }
  play(){
    if(this.totalM<=0)return
    if(this.distanceM>=this.totalM)this.replay()
    if(this.stage==='science')this.visitedScience=true
    this.playing=true;this.stage='playing'
  }
  pause(){this.playing=false;if(this.stage==='playing')this.stage='paused'}
  replay(){this.distanceM=0;this.playing=false;this.stage='ready';this.visitedScience=false}
  advance(seconds:number,metresPerSecond:number){
    if(!Number.isFinite(seconds)||!Number.isFinite(metresPerSecond)||seconds<0||metresPerSecond<=0)throw new Error('Invalid preview advance')
    if(!this.playing)return
    const next=Math.min(this.totalM,this.distanceM+seconds*metresPerSecond)
    if(!this.visitedScience&&this.distanceM<this.turnaroundM&&next>=this.turnaroundM){
      this.distanceM=this.turnaroundM;this.visitedScience=true;this.playing=false;this.stage='science';return
    }
    this.distanceM=next
    if(next>=this.totalM){this.playing=false;this.stage='complete'}
  }
}

export type RouteFrame={sample:ProfileSample;forwardEast:number;forwardNorth:number;forwardUp:number;ahead:ProfileSample}
export function createRouteTrack(route:ProfileRoute,warningDeg:number){
  const sample=createProfileSampler(route,warningDeg),points=profilePoints(route)
  return (distance:number):RouteFrame=>{
    const current=sample(distance),d=current.distanceM
    // Forward segment at a knot, including the return segment at turnaround.
    // At the final point retain the arrival heading instead of looking back.
    let lo=0,hi=points.length-1
    while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].cumulativeDistanceM<=d+1e-8)lo=mid+1;else hi=mid}
    let i=Math.max(1,lo),a=points[i-1],b=points[i]??a
    while(i<points.length-1&&Math.hypot(b.eastM-a.eastM,b.northM-a.northM)<1e-8){i++;a=points[i-1];b=points[i]}
    const east=b.eastM-a.eastM,north=b.northM-a.northM,length=Math.hypot(east,north)
    const legEnd=d<route.turnaroundDistanceM-1e-8?route.turnaroundDistanceM:route.metrics.distanceM
    return {sample:current,forwardEast:length>1e-8?east/length:1,forwardNorth:length>1e-8?north/length:0,forwardUp:length>1e-8?(b.elevationM-a.elevationM)/length:0,ahead:sample(Math.min(legEnd,d+8))}
  }
}
