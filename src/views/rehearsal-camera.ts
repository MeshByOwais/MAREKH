import type {RouteFrame} from '../mission/rehearsal.ts'
export function rehearsalCamera(mode:'flyover'|'helmet',frame:RouteFrame){
  const p=frame.sample
  if(mode==='helmet')return {
    eye:{eastM:p.eastM,northM:p.northM,elevationM:p.elevationM+1.7},
    target:{eastM:p.eastM+8*frame.forwardEast,northM:p.northM+8*frame.forwardNorth,elevationM:p.elevationM+1.7+8*frame.forwardUp},
    fov:68,
  }
  const east=frame.ahead.eastM-p.eastM,north=frame.ahead.northM-p.northM,h=Math.hypot(east,north)
  const e=h>1e-6?east/h:frame.forwardEast,n=h>1e-6?north/h:frame.forwardNorth
  return {
    eye:{eastM:p.eastM-22*e+9*n,northM:p.northM-22*n-9*e,elevationM:p.elevationM+24},
    target:{eastM:p.eastM+8*e,northM:p.northM+8*n,elevationM:p.elevationM+1.2},
    fov:42,
  }
}
