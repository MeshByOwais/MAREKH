import { averageAbsoluteGrade } from './routing/continuous.ts'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { cellCenter, readFloatGrid, worldToPixel, type RealTerrainManifest } from './terrain/package.ts'
import { buildSurface } from './terrain/surface.ts'
import type { Route, Rules } from './routing/planner.ts'
import { createPlanningUI, type InspectableRoute } from './planning-ui.ts'
import type { LivePlan, PlanningConfig } from './routing/interactive.ts'
type DisplayRoute = Pick<Route, 'status' | 'datasetVersion' | 'metrics'> & InspectableRoute
type Endpoint = {eastM:number;northM:number;geometry:{coordinates:number[][][]}}

type Feature = { id: string; kind: string; name: string; geometry: { type: 'Point' | 'Polygon'; coordinates: number[] | number[][][] } }
type Mission = { features: Feature[] }
const root = new URL(`${import.meta.env.BASE_URL}sites/columbia-hills/terrain-v1/`, location.href)
const node = (id: string) => document.getElementById(id)!
const details = node('terrain-summary'), status = node('renderer-status'), container = node('terrain-view')

async function sha256(buffer: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('')
}
async function bytes(name: string, manifest: Pick<RealTerrainManifest, 'assets'>, base = root) {
  const response = await fetch(new URL(name, base))
  if (!response.ok) throw new Error(`Missing terrain asset: ${name}`)
  const buffer = await response.arrayBuffer()
  const asset = manifest.assets[name]
  if (!asset || buffer.byteLength !== asset.bytes) throw new Error(`Incorrect terrain asset size: ${name}`)
  const hash = await sha256(buffer)
  if (hash !== asset.sha256) throw new Error(`Terrain checksum mismatch: ${name}`)
  return new Uint8Array(buffer)
}

try {
  const response = await fetch(new URL('manifest.json', root))
  if (!response.ok) throw new Error('Terrain manifest is unavailable; run the real terrain preparation command.')
  const manifestBuffer = await response.arrayBuffer()
  const manifest: RealTerrainManifest = JSON.parse(new TextDecoder().decode(manifestBuffer))
  if (manifest.schemaVersion !== 2 || manifest.datasetVersion !== 'columbia-hills-terrain-1' || manifest.render.verticalScale !== 1) throw new Error('Unsupported terrain package')
  const [elevationBytes, slopeBytes, coverage, exclusions, missionBytes] = await Promise.all(
    ['elevation.f32', 'slope-deg.f32', 'coverage.u8', 'exclusions.u8', 'mission.json'].map(name => bytes(name, manifest)),
  )
  const height = readFloatGrid(elevationBytes), slope = readFloatGrid(slopeBytes)
  const mission: Mission = JSON.parse(new TextDecoder().decode(missionBytes))
  const surface = buildSurface(manifest, height, coverage)
  const origin = manifest.localOrigin
  const { columns, rows } = manifest
  let routeRules: Rules | undefined
  let validatedApproach: number[] | undefined
  if (slope.length !== height.length || exclusions.length !== height.length) throw new Error('Terrain grid dimensions do not match')
  node('grid-resolution').textContent = `${manifest.transform[1].toFixed(3)} m / cell`
  node('coverage-summary').textContent = `${(100 * manifest.statistics.validCells / manifest.statistics.cells).toFixed(2)}%`
  node('elevation-range').textContent = `${manifest.statistics.elevationMinM.toFixed(1)} to ${manifest.statistics.elevationMaxM.toFixed(1)} m`
  details.textContent = `Real HiRISE terrain · ${columns} × ${rows} native cells · SHA-256 verified · ${surface.indices.length / 3} display triangles`

  function grid(east: number, north: number) {
    const point = worldToPixel(manifest.transform, east, north)
    const row = Math.floor(point.row + 0.5), column = Math.floor(point.column + 0.5)
    if (row < 0 || row >= rows || column < 0 || column >= columns) return undefined
    return { row, column, index: row * columns + column }
  }
  function position(east: number, north: number, lift = 1.4) {
    const cell = grid(east, north)
    if (!cell || coverage[cell.index] !== 1) return undefined
    return new THREE.Vector3(east - origin.eastM, height[cell.index] - origin.elevationM + lift, -(north - origin.northM))
  }
  function inspect(east: number, north: number, title: string) {
    node('sample-heading').textContent = title
    const cell = grid(east, north)
    if (!cell) { node('sample-validity').textContent = 'Outside the terrain footprint'; return }
    const center = cellCenter(manifest.transform, cell.row, cell.column)
    node('sample-height').textContent = Number.isFinite(height[cell.index]) ? `${height[cell.index].toFixed(2)} m` : 'Unavailable'
    node('sample-slope').textContent = coverage[cell.index] === 1 ? `${slope[cell.index].toFixed(2)}°` : 'Unavailable'
    node('sample-cell').textContent = `${cell.row}, ${cell.column}`
    node('sample-position').textContent = `${center.x.toFixed(2)} m E / ${center.y.toFixed(2)} m N`
    node('sample-validity').textContent = coverage[cell.index] !== 1 ? 'Unknown elevation, slope or image coverage' : exclusions[cell.index] === 1 ? 'Known terrain · reviewed planning exclusion' : !routeRules ? 'Known terrain · routing rules unavailable' : slope[cell.index] > routeRules.routeSlopeLimitDeg ? `Known terrain · above the ${routeRules.routeSlopeLimitDeg}° demo route limit` : 'Known terrain · within cell slope limit; move grades require separate checks'
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.append(renderer.domElement)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color('#172129')
  const camera = new THREE.PerspectiveCamera(42, 1, 0.2, 6000)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.minDistance = 35; controls.maxDistance = 2600; controls.maxPolarAngle = Math.PI * 0.495
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(surface.positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(surface.uv, 2))
  geometry.setIndex(new THREE.BufferAttribute(surface.indices, 1))
  geometry.computeBoundingSphere()
  const loader = new THREE.TextureLoader()
  const textures = new Map<string, THREE.Texture>()
  async function texture(name: string) {
    const cached = textures.get(name)
    if (cached) return cached
    const value = await loader.loadAsync(new URL(name, root).href)
    value.colorSpace = THREE.SRGBColorSpace
    value.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    textures.set(name, value)
    return value
  }
  const material = new THREE.MeshBasicMaterial({ map: await texture('texture.webp'), side: THREE.DoubleSide })
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)
  const exclusionMaterial = new THREE.MeshBasicMaterial({ map: await texture('exclusions.webp'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide })
  const exclusionMesh = new THREE.Mesh(geometry, exclusionMaterial)
  exclusionMesh.renderOrder = 1; scene.add(exclusionMesh)
  const draw = () => renderer.render(scene, camera)
  const colors: Record<string, string> = { home: '#72dbef', science: '#ffbc5c', approach: '#ffffff', staging: '#8cffa7' }
  for (const feature of mission.features) {
    const color = colors[feature.kind] ?? '#ffffff'
    if (feature.geometry.type === 'Point') {
      const [east, north] = feature.geometry.coordinates as number[]
      const point = position(east, north, 2)
      if (point) {
        const marker = new THREE.Mesh(new THREE.SphereGeometry(1.8, 12, 8), new THREE.MeshBasicMaterial({ color }))
        marker.position.copy(point); scene.add(marker)
      }
    } else {
      const ring = (feature.geometry.coordinates as number[][][])[0]
      let points: THREE.Vector3[] = []
      const addLine = () => {
        if (points.length > 1) scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color })))
        points = []
      }
      for (let index = 1; index < ring.length; index++) {
        const a = ring[index - 1], b = ring[index]
        const count = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 1.5)
        for (let step = 0; step <= count; step++) {
          const t = step / count
          const point = position(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
          if (point) points.push(point); else addLine()
        }
      }
      addLine()
    }
  }
  // Saved audited plans and live worker plans share one map and distance cursor.
  const routeGroup = new THREE.Group()
  scene.add(routeGroup)
  const crewClearance = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,side:THREE.DoubleSide}))
  crewClearance.visible=false;crewClearance.renderOrder=2;scene.add(crewClearance)
  let crewLayerActive=false,loadGeneration=0
  node('show-crew-clearance').addEventListener('change',event=>{crewClearance.visible=crewLayerActive&&(event.target as HTMLInputElement).checked;draw()})
  node('show-routes').addEventListener('change', event => {
    routeGroup.visible = (event.target as HTMLInputElement).checked; cursorMarker.visible=routeGroup.visible;draw()
  })

  function renderRoutes(routes:DisplayRoute[],endpoints:Record<string,Endpoint>,mode:'global'|'crew'|'baseline'|'continuous') {
    const global=mode==='global',crew=mode!=='baseline'
    for(const child of routeGroup.children){const object=child as THREE.Mesh;object.geometry?.dispose();if(object.material){const materials=Array.isArray(object.material)?object.material:[object.material];materials.forEach(m=>m.dispose())}}
    routeGroup.clear();node('route-results').replaceChildren()
    for (const [routeIndex,route] of routes.entries()) {
      const points = route.outbound.points.map(p => new THREE.Vector3(p.eastM - origin.eastM, p.elevationM - origin.elevationM + 1.6, -(p.northM - origin.northM)))
      const distancePolicy=route.policy==='shortest'||route.policy==='distance'
      const color = distancePolicy ? '#ffe26c' : '#29e6b6'
      const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color,transparent:true}));line.userData.routeIndex=routeIndex;routeGroup.add(line)
      const row = document.createElement('tr'), m = route.metrics
      for (const value of [mode==='continuous'?(route.policy==='minimax-grade'?'Gentler · distance limit':'Shorter · peak limit'):global?'Best grade candidate':crew?(distancePolicy?'Distance priority':'Terrain priority'):(distancePolicy?'Shortest':'Gentler terrain'), `${m.distanceM.toFixed(2)} m`, `${m.positiveClimbM.toFixed(2)} m`, `${m.maxSurfaceSlopeDeg.toFixed(2)}°`, `${m.maxAbsGradeDeg.toFixed(2)}°`, `${averageAbsoluteGrade([route.outbound,route.returnLeg]).toFixed(2)}°`, String(m.warningEdgeCount)]) {
        const cell = document.createElement(row.children.length ? 'td' : 'th')
        if (cell.tagName === 'TH') { cell.setAttribute('scope', 'row'); cell.className = distancePolicy?'shortest':'gentle' }
        if(cell.tagName==='TH'){const button=document.createElement('button');button.type='button';button.className='route-policy-button';button.dataset.routeChoice=String(routeIndex);button.textContent=value;cell.append(button)}else cell.textContent=value;row.append(cell)
      }
      node('route-results').append(row)
    }
    for (const name of ['staging', 'approach']) {
      const endpoint = endpoints[name], point = position(endpoint.eastM, endpoint.northM, 2.2)!
      const marker = new THREE.Mesh(new THREE.SphereGeometry(2, 12, 8), new THREE.MeshBasicMaterial({ color: '#ffffff' }))
      marker.position.copy(point); routeGroup.add(marker)
      const ring = endpoint.geometry.coordinates[0] as number[][], footprint: THREE.Vector3[] = []
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1], b = ring[i], count = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]))
        for (let j = 0; j <= count; j++) { const p = position(a[0] + (b[0] - a[0]) * j / count, a[1] + (b[1] - a[1]) * j / count, 1.6); if (p) footprint.push(p) }
      }
      routeGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(footprint), new THREE.LineBasicMaterial({ color: '#ffffff' })))
    }
  }

  const cursorMarker=new THREE.Mesh(new THREE.SphereGeometry(2.5,16,10),new THREE.MeshBasicMaterial({color:'#ffe26c',depthTest:false}));cursorMarker.renderOrder=5;cursorMarker.visible=false;scene.add(cursorMarker)
  const candidateMarker=new THREE.Mesh(new THREE.SphereGeometry(2.7,12,8),new THREE.MeshBasicMaterial({color:'#e7ac79',wireframe:true,depthTest:false}));candidateMarker.renderOrder=6;candidateMarker.visible=false;scene.add(candidateMarker)
  const candidateFootprint=new THREE.Line(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:'#e7ac79',depthTest:false}));candidateFootprint.renderOrder=6;candidateFootprint.visible=false;scene.add(candidateFootprint)
  const planning=createPlanningUI({...manifest,elevation:height,slope,coverage,exclusions},{
    cursor(sample){cursorMarker.position.set(sample.eastM-origin.eastM,sample.elevationM-origin.elevationM+2.5,-(sample.northM-origin.northM));cursorMarker.material.color.set(sample.reasons.length?'#ff7279':'#ffe26c');cursorMarker.visible=routeGroup.visible;draw()},
    choose(index){for(const child of routeGroup.children)if(child.userData.routeIndex!==undefined){const line=child as THREE.Line<THREE.BufferGeometry,THREE.LineBasicMaterial>;line.material.opacity=child.userData.routeIndex===index?1:.25};draw()},
    candidate(cell,valid,widthM=10,heightM=10){
      const xy=cell?cellCenter(manifest.transform,cell.row,cell.column):undefined,p=xy?position(xy.x,xy.y,3):undefined,color=valid?'#8cffa7':'#ff7279'
      candidateMarker.visible=!!p;candidateMarker.material.color.set(color);if(p)candidateMarker.position.copy(p)
      const points:THREE.Vector3[]=[]
      if(xy){const w=xy.x-widthM/2,e=xy.x+widthM/2,s=xy.y-heightM/2,n=xy.y+heightM/2,ring=[[w,s],[e,s],[e,n],[w,n],[w,s]]
        for(let i=1;i<ring.length;i++){const a=ring[i-1],b=ring[i],steps=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1]));for(let j=0;j<=steps;j++){const v=position(a[0]+(b[0]-a[0])*j/steps,a[1]+(b[1]-a[1])*j/steps,3);if(v)points.push(v)}}}
      candidateFootprint.visible=points.length>1;candidateFootprint.geometry.dispose();candidateFootprint.geometry=new THREE.BufferGeometry().setFromPoints(points);candidateFootprint.material.color.set(color)
      node('candidate-key').hidden=!cell;node('candidate-key').textContent=valid?'New staging square · passes footprint checks':'New staging square · rejected';node('candidate-key').style.color=color
      draw()
    },
    searchStarted(){++loadGeneration},
    live(plan:LivePlan,config:PlanningConfig){
      const endpoints:Record<string,Endpoint>={}
      for(const [name,p]of Object.entries({staging:plan.staging,approach:plan.approach})){const [w,s,e,n]=p.boundsWSEN;endpoints[name]={...p,geometry:{coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}}}
      renderRoutes(plan.routes,endpoints,plan.mode)
      node('live-bounds').hidden=true;node('optimality-bounds').hidden=true;node('route-downloads').hidden=true;node('saved-review').hidden=true;node('result-kind').textContent='Live planning result'
      node('route-status').textContent=`Live plan · ${plan.checkedPieces} ${plan.mode==='crew'?'native pieces':'edges'} rechecked by the engine on both legs. No separate source audit or continuous optimality certificate has been generated for this start.`
      node('endpoint-summary').textContent=`Staging ${plan.staging.cell.row}, ${plan.staging.cell.column}: ${plan.staging.cellCount} touched native cells in a 10 m square; maximum slope ${plan.staging.maxSlopeDeg.toFixed(2)}°. Science approach is unchanged.`
      node('model-summary').textContent=plan.mode==='crew'?'Live NASA-informed crew adaptation: Field D* guidance, local crew steps, native roughness and 1 m clearance. Both policies use the selected staging point. Search is heuristic.':'Live A* baseline: eight-neighbour point-path routes. Departure footprint is checked; crew clearance is not swept along this baseline.'
      node('warning-summary').textContent='Live planning compares distance and terrain cost. It does not minimize peak grade or impose the saved candidate’s 500 m budget. Inspect red profile pieces for surface-slope warnings.'
      if(plan.mode==='continuous'){
        const m=plan.routes[0].metrics,avg=averageAbsoluteGrade([plan.routes[0].outbound,plan.routes[0].returnLeg])
        node('route-status').textContent=`Updated · ${m.distanceM.toFixed(2)} m round trip · ${m.maxAbsGradeDeg.toFixed(2)}° peak grade · ${avg.toFixed(2)}° average absolute grade. ${plan.checkedPieces} native pieces checked independently on both legs.`
        node('model-summary').textContent=plan.searchScope??'Native triangle portal search with continuous corridor improvement.'
        node('warning-summary').textContent=`Total round-trip distance ≤${plan.options!.roundTripBudgetM} m. ${plan.options!.objective==='gentlest'?'The search seeks the lowest peak walking-grade candidate within that budget.':`Every native piece has walking grade ≤${plan.options!.gradeLimitDeg}°.`} Surface slope and crew clearance remain separate checks. Tight turns are permitted.`
        const b=plan.continuousOptimalityBounds
        node('live-bounds').hidden=!b
        if(b)node('live-bounds').textContent=`Continuous bounds: minimum possible peak grade within this distance budget is between ${(Math.floor(b.gradeLowerDeg*1000)/1000).toFixed(3)}° and ${(Math.ceil(b.gradeUpperDeg*1000)/1000).toFixed(3)}°. Distance at the peak grade cap: ${(Math.floor(b.distanceLowerM*100)/100).toFixed(2)}–${(Math.ceil(b.distanceUpperM*100)/100).toFixed(2)} m. These endpoint-based bounds can be wide; the exact optimum remains unknown. The saved route’s tighter certificates do not apply to this search.`
        node('distance-legend').parentElement!.hidden=plan.routes[0].policy==='minimax-grade'
        node('terrain-legend').parentElement!.hidden=plan.routes[0].policy!=='minimax-grade'
        node('distance-legend').textContent='Shorter · grade limit';node('terrain-legend').textContent='Gentler · distance limit'
      }
      container.setAttribute('aria-label','Interactive HiRISE terrain showing live route options, staging footprint and the linked profile marker.')
      draw()
    }
  })
  async function loadRoutes(mode: 'global'|'crew'|'baseline') {
   planning.cancel('Loading the selected saved model…');const generation=++loadGeneration
   try {
    const global=mode==='global',crew=mode!=='baseline',version=global?'columbia-hills-global-grade-1':crew?'columbia-hills-crew-navigation-1':'columbia-hills-routes-1'
    const base = new URL(global?'../global-grade-v1/':crew?'../crew-navigation-v1/':'../routes-v1/', root)
    const response = await fetch(new URL('manifest.json', base))
    if (!response.ok) throw new Error('Generate and validate the Phase 3 route package first.')
    const packageManifest = await response.json()
    if (packageManifest.schemaVersion !== 1 || packageManifest.routeVersion !== version || packageManifest.datasetVersion !== manifest.datasetVersion || packageManifest.terrainManifestSha256 !== await sha256(manifestBuffer)) throw new Error('Saved routes do not match the displayed terrain')
    const decode = (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data))
    const [result, endpoints, config, audit] = (await Promise.all(['routes.json', 'mission.json', 'config.json', 'validation.json'].map(name => bytes(name, packageManifest, base)))).map(decode)
    if (audit.status !== 'passed' || audit.routeVersion !== packageManifest.routeVersion || audit.datasetVersion !== manifest.datasetVersion || config.datasetVersion !== manifest.datasetVersion || result.datasetVersion !== manifest.datasetVersion) throw new Error('Route audit is unavailable or belongs to another dataset')
    const routes: DisplayRoute[] = result.routes
    if (routes.length !== (global?1:2) || routes.some(r => r.status !== 'ok' || r.datasetVersion !== manifest.datasetVersion)) throw new Error('Saved route result is incomplete')
    const bounds=global?decode(await bytes('bounds.json',packageManifest,base)):undefined
    if(global&&(!bounds||bounds.exactOptimumClaimed!==false||bounds.gradeLowerDeg>=bounds.gradeUpperDeg||bounds.roundTripBudgetM!==500||JSON.stringify(bounds)!==JSON.stringify(audit.bounds)))throw new Error('Optimality bounds do not match the independent audit')
    const clearanceMap=crew?await texture('../crew-navigation-v1/crew-clearance.webp'):undefined
    let stagingHazard:Uint8Array|undefined
    if(crew){
      const crewBase=new URL('../crew-navigation-v1/',root)
      let hazardManifest=packageManifest
      if(global){
        const response=await fetch(new URL('manifest.json',crewBase))
        if(!response.ok)throw new Error('Crew hazard assessment is unavailable')
        const buffer=await response.arrayBuffer()
        if(await sha256(buffer)!==packageManifest.crewManifestSha256)throw new Error('Crew hazard assessment does not match the saved grade model')
        hazardManifest=JSON.parse(new TextDecoder().decode(buffer))
      }
      stagingHazard=await bytes('hazard.u8',hazardManifest,crewBase)
    }
    if(generation!==loadGeneration)return
    renderRoutes(routes,endpoints,mode)
    const totalEdges = audit.routes.reduce((sum: number, r: { checkedEdges: number }) => sum + r.checkedEdges, 0)
    node('route-status').textContent = `Verified · ${totalEdges} ${crew?'native pieces':'edges'} checked independently · outbound and return · ${packageManifest.routeVersion}`
    node('live-bounds').hidden=true
    node('optimality-bounds').hidden=!global
    if(bounds){
      node('grade-bound').textContent=`${bounds.gradeLowerDeg.toFixed(3)}°–${bounds.gradeUpperDeg.toFixed(3)}°`
      node('grade-gap').textContent=`The best possible peak grade lies in this interval under the 500 m round-trip limit. Remaining gap: ${bounds.gradeGapDeg.toFixed(3)}°.`
      node('distance-bound').textContent=`${(Math.floor(bounds.secondaryDistanceLowerM*100)/100).toFixed(2)}–${(Math.ceil(bounds.secondaryDistanceUpperM*100)/100).toFixed(2)} m`
      node('distance-gap').textContent=`At the chosen ${bounds.secondaryGradeCapDeg.toFixed(3)}° grade cap, the shortest possible round trip lies in this interval. Remaining distance gap: ${bounds.secondaryDistanceGapM.toFixed(2)} m. This is a separate distance bound at that cap.`
      ;(node('bound-data') as HTMLAnchorElement).href=new URL('bounds.json',base).href
    }
    node('endpoint-summary').textContent = `Staging: ${endpoints.staging.cellCount} touched cells in a 10 m square, maximum ${endpoints.staging.maxSlopeDeg.toFixed(2)}°. Approach: ${endpoints.approach.cellCount} cells in a 2 m square; adopted cell center is ${endpoints.approach.adoptedCenterDisplacementM.toFixed(2)} m from the original proposal.`
    node('rule-summary').textContent = `Demo limits: warning >${config.rules.warningSlopeDeg}° · route surface ≤${config.rules.routeSlopeLimitDeg}° · staging ≤${config.rules.stagingSlopeLimitDeg}° · absolute move grade ≤${config.rules.moveGradeLimitDeg}°. Return follows the same geometry; signed grades and climb are recalculated. Travel time is unavailable.`
    node('model-summary').textContent=global?'Minimize the steepest walking grade within a 500 m round trip, then seek the shortest route at the reported grade cap. Headings can vary across the native terrain. The same 1 m crew clearance and roughness limits apply. Longer switchbacks reduce walking grade; tight turns are permitted by this model.':crew?`NASA-informed crew adaptation: Field D* goal guidance + local step evaluation. A ${(config.crewModel.bodyRadiusM+config.crewModel.clearanceMarginM).toFixed(1)} m crew-and-margin radius is checked along the whole path. Native terrain roughness also contributes to planning. Uses orbital data; no onboard sensing or rover suspension is simulated.`:'Phase 3 A* comparison: eight-neighbour routing with point-path checks. The departure footprint is checked; a crew-width footprint is not swept along this baseline route.'
    node('warning-summary').textContent=global?'Walking grade measures steepness along the route. Surface slope measures the underlying ground, so crossing a hillside gently does not make its side slope disappear. Warning counts refer to native pieces above 10° surface slope.':crew?'Warnings count native linear pieces above 10° surface slope on both legs. Terrain priority adds slope and roughness costs; it does not guarantee the smallest maximum slope or minimum climb. Local step selection is heuristic.':'Warnings count grid edges above 10° surface slope on both legs. Gentler terrain adds a slope cost and may involve more climbing.'
    node('verification-summary').textContent=global?'The feasible route is checked piece by piece against the native terrain and swept crew clearance. A separate lower-bound check covers every allowed direction on every terrain triangle in the budget area, including paths the route search did not sample. Downloads include the saved route, bound certificates and independent audit.':!crew?'Each A* edge is checked against native coverage, exclusions, surface slope and travel grade. The independent audit checks source heights, endpoint footprints and both legs. This point-path baseline does not sweep crew clearance along the route.':'Field D* supplies global terrain-cost guidance. Local crew steps must pass clearance, slope, roughness and along-move grade checks before selection. Native triangle crossings remain in the saved path. An independent checker verifies every piece and sweeps the crew footprint against hazard cells. The original A* milestone remains available in the model selector.'
    node('distance-legend').textContent=crew?'Distance priority':'Shortest'
    node('distance-legend').parentElement!.hidden=global
    node('terrain-legend').parentElement!.hidden=false
    node('terrain-legend').textContent=global?'Grade candidate':crew?'Terrain priority':'Gentler terrain'
    container.setAttribute('aria-label',global?'Interactive three-dimensional HiRISE terrain around Home Plate, showing the lowest-peak-grade candidate with continuous optimality bounds, checked endpoints and crew clearance cells.':crew?'Interactive three-dimensional HiRISE terrain around Home Plate, showing distance-priority and terrain-priority crew routes, checked endpoints and crew clearance cells.':'Interactive three-dimensional HiRISE terrain around Home Plate, showing shortest and gentler Phase 3 A* baseline routes and checked endpoints.')
    crewLayerActive=crew;crewClearance.material.map=clearanceMap??null;crewClearance.material.needsUpdate=true;crewClearance.visible=crew&&(node('show-crew-clearance') as HTMLInputElement).checked
    ;(node('show-crew-clearance') as HTMLInputElement).disabled=!crew
    for(const [id,name]of [['route-data','routes.json'],['route-gis','route-review.gpkg'],['route-audit','validation.json'],['route-review-link','route-review.png']]) (node(id) as HTMLAnchorElement).href=new URL(name,base).href
    ;(node('route-review-image') as HTMLImageElement).src=new URL('route-review.png',base).href
    ;(node('route-review-image') as HTMLImageElement).alt=global?'North-up orbital image showing the bounded-grade candidate from the checked staging square to the science approach.':'North-up orbital image showing the two selected route policies and their checked endpoint footprints.'
    routeRules = config.rules
    validatedApproach = [endpoints.approach.eastM, endpoints.approach.northM]
    node('route-downloads').hidden = false;node('saved-review').hidden=false;node('result-kind').textContent='Saved planning result'
    planning.saved(routes,config,mode,stagingHazard)
    draw()
  } catch (error) {
    if(generation!==loadGeneration)return
    console.error(error)
    node('route-status').textContent = error instanceof Error ? `Selected model unavailable: ${error.message}. The last loaded plan is retained.` : 'Selected routes could not load'
  }
  }
  node('navigation-model').addEventListener('change',event=>{void loadRoutes((event.target as HTMLSelectElement).value as 'global'|'crew'|'baseline')})
  await loadRoutes('global')
  const home = mission.features.find(feature => feature.id === 'home-plate')!
  const ring = (home.geometry.coordinates as number[][][])[0].slice(0, -1)
  const center = ring.reduce((sum, p) => [sum[0] + p[0] / ring.length, sum[1] + p[1] / ring.length], [0, 0])
  const homeTarget = position(center[0], center[1], 0)!
  function setView(view: 'home' | 'full' | 'north') {
    const target = view === 'full' ? new THREE.Vector3(0, 0, 0) : homeTarget
    controls.target.copy(target)
    const offset = view === 'full' ? new THREE.Vector3(780, 820, 880) : view === 'north' ? new THREE.Vector3(0, 440, 0.001) : new THREE.Vector3(140, 180, 230)
    if (view === 'full') offset.multiplyScalar(1.2 * Math.max(1, 1 / camera.aspect))
    camera.position.copy(target).add(offset)
    camera.up.set(0, 1, 0); camera.lookAt(target); controls.update(); draw()
    for (const [id, mode] of [['home-view', 'home'], ['full-view', 'full'], ['north-view', 'north']]) {
      node(id).setAttribute('aria-pressed', String(mode === view))
    }
  }
  node('home-view').addEventListener('click', () => setView('home'))
  node('full-view').addEventListener('click', () => setView('full'))
  node('north-view').addEventListener('click', () => setView('north'))
  node('show-exclusions').addEventListener('change', event => {
    exclusionMesh.visible = (event.target as HTMLInputElement).checked; draw()
  })
  let requestedLayer = 'texture.webp'
  for (const input of document.querySelectorAll<HTMLInputElement>('input[name=surface]')) input.addEventListener('change', async () => {
    const selected = input.value; requestedLayer = selected
    try {
      const map = await texture(selected)
      if (requestedLayer !== selected) return
      material.map = map; material.needsUpdate = true
      node('slope-key').hidden = selected !== 'slope.webp'
      draw()
    } catch (error) { console.error(error); status.textContent = 'The selected surface layer could not load.' }
  })
  const raycaster = new THREE.Raycaster()
  let down = [0, 0]
  renderer.domElement.addEventListener('pointerdown', event => { down = [event.clientX, event.clientY] })
  renderer.domElement.addEventListener('pointerup', event => {
    if (Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return
    const box = renderer.domElement.getBoundingClientRect()
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1), camera)
    const hit = raycaster.intersectObject(mesh)[0]
    if (hit) {const east=hit.point.x+origin.eastM,north=origin.northM-hit.point.z,cell=grid(east,north);inspect(east,north,'Selected terrain cell');if(cell)planning.chooseCell(cell)}
  })
  function mapReference() {
    // Project a true-north ground direction into the current screen orientation.
    const target=controls.target.clone(),north=target.clone().add(new THREE.Vector3(0,0,-10)),a=target.clone().project(camera),b=north.project(camera)
    const angle=Math.atan2((b.x-a.x)*container.clientWidth,-(b.y-a.y)*container.clientHeight)*180/Math.PI
    ;(document.querySelector('.map-compass') as HTMLElement).style.transform=`rotate(${angle}deg)`
    const box=renderer.domElement.getBoundingClientRect(),width=box.width,height=box.height
    if(!width||!height)return
    const hits=[-40,40].map(offset=>{raycaster.setFromCamera(new THREE.Vector2(offset/width*2,0),camera);return raycaster.intersectObject(mesh)[0]?.point})
    node('map-scale-label').textContent=hits[0]&&hits[1]?`${Math.hypot(hits[1].x-hits[0].x,hits[1].z-hits[0].z).toFixed(1)} m · at view centre`:'Scale unavailable in this view'
  }
  controls.addEventListener('change',()=>{mapReference();draw()})
  const resize = new ResizeObserver(() => {
    renderer.setSize(container.clientWidth, container.clientHeight)
    camera.aspect = container.clientWidth / container.clientHeight; camera.updateProjectionMatrix();mapReference();draw()
  })
  resize.observe(container)
  const approach = validatedApproach ?? mission.features.find(feature => feature.id === 'science-approach')!.geometry.coordinates as number[]
  inspect(approach[0], approach[1], validatedApproach ? 'Demo science approach' : 'Proposed approach')
  setView('home')
  status.textContent = `Ready · ${manifest.transform[1].toFixed(3)} m analytic grid · approximately ${(manifest.transform[1] * manifest.render.stride).toFixed(2)} m display spacing · missing terrain stays open`
} catch (error) {
  console.error(error)
  details.textContent = error instanceof Error ? error.message : 'Terrain package could not load.'
  status.textContent = 'Run the terrain preparation and build commands, then use the local preview server. A WebGL-capable browser is required.'
}
