import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { cellCenter, readFloatGrid, type TerrainManifest } from './terrain/package.ts'

const details = document.querySelector<HTMLElement>('#terrain-summary')!
const rendererStatus = document.querySelector<HTMLElement>('#renderer-status')!
const container = document.querySelector<HTMLElement>('#terrain-view')!

async function loadBytes(url: URL): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Terrain asset unavailable: ${url.pathname}`)
  return new Uint8Array(await response.arrayBuffer())
}

try {
  const root = new URL(`${import.meta.env.BASE_URL}sites/columbia-hills/synthetic/`, location.href)
  const response = await fetch(new URL('manifest.json', root))
  if (!response.ok) throw new Error('Terrain manifest unavailable')
  const manifest: TerrainManifest = await response.json()
  const [heightBytes, coverage] = await Promise.all([
    loadBytes(new URL('elevation.f32', root)), loadBytes(new URL('coverage.u8', root)),
  ])
  const elevations = readFloatGrid(heightBytes)
  if (elevations.length !== manifest.rows * manifest.columns || coverage.length !== elevations.length) {
    throw new Error('Terrain asset dimensions do not match the manifest')
  }
  details.textContent = `Synthetic fixture loaded. ${manifest.columns} × ${manifest.rows} cells at ${manifest.transform[1]} m per cell.`
  document.querySelector('#coverage-summary')!.textContent = `${coverage.reduce((sum, cell) => sum + cell, 0)} / ${coverage.length} valid cells`

  try {
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    container.append(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#15212a')
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000)
    camera.position.set(65, 52, 72)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.minDistance = 30
    controls.maxDistance = 200
    const origin = cellCenter(manifest.transform, (manifest.rows - 1) / 2, (manifest.columns - 1) / 2)
    const positions: number[] = []
    const indices: number[] = []
    for (let row = 0; row < manifest.rows; row++) {
      for (let column = 0; column < manifest.columns; column++) {
        const i = row * manifest.columns + column
        const point = cellCenter(manifest.transform, row, column)
        // Local east -> +X, up -> +Y, north -> -Z. Keep source elevation for analysis.
        positions.push(point.x - origin.x, coverage[i] ? elevations[i] - 112.5 : 0, -(point.y - origin.y))
        if (row === manifest.rows - 1 || column === manifest.columns - 1) continue
        const corners = [i, i + 1, i + manifest.columns, i + manifest.columns + 1]
        if (corners.every(index => coverage[index] === 1)) {
          indices.push(i, i + manifest.columns, i + 1, i + 1, i + manifest.columns, i + manifest.columns + 1)
        }
      }
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    scene.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#c38a60', side: THREE.DoubleSide, roughness: 1 })))
    scene.add(new THREE.LineSegments(new THREE.WireframeGeometry(geometry), new THREE.LineBasicMaterial({ color: '#f1c39c', transparent: true, opacity: 0.45 })))
    const light = new THREE.DirectionalLight('#ffffff', 2)
    light.position.set(-25, 60, 20)
    scene.add(light, new THREE.HemisphereLight('#e3f1ff', '#493025', 2))
    const draw = () => renderer.render(scene, camera)
    const resize = new ResizeObserver(() => {
      renderer.setSize(container.clientWidth, container.clientHeight)
      camera.aspect = container.clientWidth / container.clientHeight
      camera.updateProjectionMatrix()
      draw()
    })
    resize.observe(container)
    controls.addEventListener('change', draw)
    draw()
    rendererStatus.textContent = 'Drag to orbit · Scroll to zoom · Gaps are excluded terrain, preserved from the coverage mask.'
  } catch (error) {
    console.error(error)
    rendererStatus.textContent = 'The terrain data loaded, but the 3D preview needs WebGL support in this browser.'
  }
} catch (error) {
  console.error(error)
  details.textContent = 'Terrain package could not be loaded. Run the data preparation command, then reload.'
  rendererStatus.textContent = 'Preview unavailable until the terrain package loads.'
}
