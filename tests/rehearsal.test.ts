import {test,expect} from 'bun:test'
import {readFileSync} from 'node:fs'
import {RehearsalPlayback,createRouteTrack} from '../src/mission/rehearsal.ts'
import {createProfileSampler,sampleProfile,type ProfileRoute} from '../src/routing/profile.ts'
import {rehearsalCamera} from '../src/views/rehearsal-camera.ts'

const point=(eastM:number,elevationM:number,cumulativeDistanceM:number,grade:number)=>({eastM,northM:0,elevationM,cumulativeDistanceM,surfaceSlopeDeg:12,edgeSurfaceSlopeDeg:12,segmentGradeDeg:grade})
const route:ProfileRoute={outbound:{points:[point(0,0,0,0),point(10,1,10,5.71),point(20,2,20,5.71)]},returnLeg:{points:[point(20,2,0,0),point(10,1,10,-5.71),point(0,0,20,-5.71)]},turnaroundDistanceM:20,metrics:{distanceM:40}}

test('even a long animation frame pauses exactly at science before the return',()=>{
  const p=new RehearsalPlayback(40,20);p.play();p.advance(100,36)
  expect(p.distanceM).toBe(20);expect(p.stage).toBe('science');expect(p.playing).toBe(false)
  p.advance(100,36);expect(p.distanceM).toBe(20)
  p.play();p.advance(100,36);expect(p.distanceM).toBe(40);expect(p.stage).toBe('complete');expect(p.playing).toBe(false)
})
test('pause, seeking, replay and a second pass cannot skip the science stop',()=>{
  const p=new RehearsalPlayback(40,20);p.play();p.advance(1,6);p.pause();p.advance(1,6);expect(p.distanceM).toBe(6)
  p.seek(19);p.play();p.advance(1,6);expect(p.stage).toBe('science')
  p.seek(25);p.play();p.advance(1,6);expect(p.distanceM).toBe(31)
  p.replay();expect(p.playing).toBe(false);expect(p.distanceM).toBe(0);p.play();p.advance(4,6);expect(p.stage).toBe('science')
  p.seek(100);expect(p.distanceM).toBe(40);p.seek(-1);expect(p.distanceM).toBe(0)
})
test('invalid clocks and zero-length walks never generate invalid movement',()=>{
  for(const [total,turn]of [[NaN,1],[-1,0],[10,11]])expect(()=>new RehearsalPlayback(total,turn)).toThrow()
  const p=new RehearsalPlayback(0,0);p.play();expect(p.playing).toBe(false);expect(()=>p.seek(NaN)).toThrow();expect(()=>p.advance(-1,6)).toThrow()
  const single={outbound:{points:[point(0,0,0,0)]},returnLeg:{points:[point(0,0,0,0)]},turnaroundDistanceM:0,metrics:{distanceM:0}}
  const camera=rehearsalCamera('helmet',createRouteTrack(single,10)(0));expect(camera.eye.elevationM).toBe(1.7);expect(Number.isFinite(camera.target.eastM)).toBe(true)
})
test('profile and rehearsal agree at every leg boundary and warning sample',()=>{
  const cached=createProfileSampler(route,10),track=createRouteTrack(route,10)
  for(const distance of [0,5,19.99,20,20.01,30,40]){
    expect(cached(distance)).toEqual(sampleProfile(route,distance,10));expect(track(distance).sample).toEqual(cached(distance));expect(track(distance).sample.reasons.length).toBe(1)
  }
  expect(cached(30).segmentGradeDeg).toBeLessThan(0)
})
test('Helmet stays 1.7 m above the route, faces return at the turn and arrival at the end',()=>{
  const track=createRouteTrack(route,10)
  const out=rehearsalCamera('helmet',track(10)),turn=rehearsalCamera('helmet',track(20)),end=rehearsalCamera('helmet',track(40))
  expect(out.eye).toEqual({eastM:10,northM:0,elevationM:2.7});expect(out.target.eastM).toBeGreaterThan(out.eye.eastM)
  expect(turn.eye.eastM).toBe(20);expect(turn.target.eastM).toBeLessThan(20);expect(turn.target.elevationM).toBeLessThan(turn.eye.elevationM)
  expect(end.eye).toEqual({eastM:0,northM:0,elevationM:1.7});expect(end.target.eastM).toBeLessThan(0)
})
test('Flyover looks along the outbound leg without turning early across the science stop',()=>{
  const track=createRouteTrack(route,10),before=rehearsalCamera('flyover',track(19))
  expect(track(19).ahead.distanceM).toBe(20);expect(before.eye.elevationM).toBeCloseTo(25.9,8);expect(before.eye.eastM).toBeLessThan(19);expect(before.target.eastM).toBeGreaterThan(19)
})
test('the committed native route closes in both camera views without changing its geometry',()=>{
  const saved=JSON.parse(readFileSync(new URL('../public/sites/columbia-hills/global-grade-v1/routes.json',import.meta.url),'utf8')).routes[0] as ProfileRoute
  const track=createRouteTrack(saved,10),start=track(0),end=track(saved.metrics.distanceM)
  for(const mode of ['flyover','helmet'] as const){
    const a=rehearsalCamera(mode,start),b=rehearsalCamera(mode,end)
    expect(b.eye.elevationM).toBeCloseTo(a.eye.elevationM,8)
    expect(end.sample.eastM).toBeCloseTo(start.sample.eastM,8);expect(end.sample.northM).toBeCloseTo(start.sample.northM,8)
    if(mode==='helmet'){expect(b.eye.eastM).toBeCloseTo(a.eye.eastM,8);expect(b.eye.northM).toBeCloseTo(a.eye.northM,8)}
  }
})
