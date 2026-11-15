export type ProfilePoint = {
  eastM: number; northM: number; elevationM: number; cumulativeDistanceM: number
  surfaceSlopeDeg: number; edgeSurfaceSlopeDeg: number; segmentGradeDeg: number
}
export type ProfileRoute = { outbound: {points: ProfilePoint[]}; returnLeg: {points: ProfilePoint[]}; turnaroundDistanceM: number; metrics: {distanceM: number} }
export type ProfileSample = ProfilePoint & { distanceM: number; leg: 'Outbound'|'Return'|'Science turnaround'; reasons: string[] }
export function slopeAlerts(slope: number, warningDeg: number) {
  return Number.isFinite(slope)&&slope>warningDeg?[`Steep surface: ${slope.toFixed(2)}° exceeds the ${warningDeg}° warning threshold.`]:[]
}
export function profilePoints(route: ProfileRoute) {
  return [...route.outbound.points,...route.returnLeg.points.slice(1).map(p=>({...p,cumulativeDistanceM:p.cumulativeDistanceM+route.turnaroundDistanceM}))]
}
export function sampleProfile(route: ProfileRoute, distance: number, warningDeg: number): ProfileSample {
  if (!Number.isFinite(distance)) throw new Error('Profile distance must be finite')
  const points=profilePoints(route),d=Math.max(0,Math.min(route.metrics.distanceM,distance))
  let lo=0,hi=points.length-1
  while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].cumulativeDistanceM<d)lo=mid+1;else hi=mid}
  const b=points[Math.max(1,lo)]??points[0],a=points[Math.max(0,lo-1)]
  const span=b.cumulativeDistanceM-a.cumulativeDistanceM,t=span>0?Math.max(0,Math.min(1,(d-a.cumulativeDistanceM)/span)):0
  const mix=(x:number,y:number)=>x+(y-x)*t
  return {...b,eastM:mix(a.eastM,b.eastM),northM:mix(a.northM,b.northM),elevationM:mix(a.elevationM,b.elevationM),cumulativeDistanceM:d,distanceM:d,
    leg:Math.abs(d-route.turnaroundDistanceM)<1e-6?'Science turnaround':d>route.turnaroundDistanceM?'Return':'Outbound',reasons:slopeAlerts(b.edgeSurfaceSlopeDeg,warningDeg)}
}
