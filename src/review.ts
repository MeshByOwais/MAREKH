type CoverageReview = {
  crop: { sizeM: [number, number]; sharedValidFraction: number; sharedValidCells: number; cells: number }
  transform: number[]
  relativeRegistrationRmsM: number
  relativeRegistrationLeaveOneOutMaxM: number
  sharedValidSourceCells: number
  sourceCells: number
}

const root = new URL(`${import.meta.env.BASE_URL}sites/columbia-hills/review/`, location.href)
const embeddedText = document.querySelector('#embedded-review')?.textContent
const embedded: { report: CoverageReview; maps: Record<string, string> } | undefined = embeddedText ? JSON.parse(embeddedText) : undefined
const map = document.querySelector<HTMLImageElement>('#review-map')!
const controls = [...document.querySelectorAll<HTMLInputElement>('input[type=radio]')]
function updateMap() {
  const layer = document.querySelector<HTMLInputElement>('input[name=layer]:checked')!.value
  const extent = document.querySelector<HTMLInputElement>('input[name=extent]:checked')!.value
  map.src = embedded?.maps[`${layer}-${extent}.png`] ?? new URL(`${layer}-${extent}.png`, root).href
  map.alt = `${layer === 'optical' ? 'HiRISE orbital image' : 'Elevation hillshade'} with registered science context and provisional staging annotations.`
  document.querySelector('#map-caption')!.textContent = `${extent === 'detail' ? 'Science context · approximately 364 m across' : 'Mission crop · approximately 1 km across'} · north up`
}
controls.forEach(control => control.addEventListener('change', updateMap))
map.addEventListener('error', () => {
  document.querySelector('#load-status')!.textContent = 'The selected map could not load. Run the site review command and reload this page.'
})
try {
  let report = embedded?.report
  if (!report) {
    const response = await fetch(new URL('coverage-review.json', root))
    if (!response.ok) throw new Error('Coverage verification record is unavailable')
    report = await response.json() as CoverageReview
  }
  document.querySelector('#crop-size')!.textContent = `${(report.crop.sizeM[0] / 1000).toFixed(3)} km square`
  document.querySelector('#valid-coverage')!.textContent = `${(100 * report.crop.sharedValidFraction).toFixed(1)}%`
  document.querySelector('#grid-scale')!.textContent = `${report.transform[1].toFixed(3)} m / pixel`
  document.querySelector('#registration-rms')!.textContent = `${report.relativeRegistrationRmsM.toFixed(2)} m`
  document.querySelector('#load-status')!.textContent = `${report.crop.sharedValidCells.toLocaleString()} crop cells checked · map-fit leave-one-out maximum ${report.relativeRegistrationLeaveOneOutMaxM.toFixed(2)} m · absolute geolocation accuracy unknown`
  document.querySelector('#source-coverage')!.textContent = `${report.sharedValidSourceCells.toLocaleString()} of ${report.sourceCells.toLocaleString()} native source cells share valid elevation and image coverage.`
} catch (error) {
  console.error(error)
  document.querySelector('#load-status')!.textContent = 'The verification record could not load. Run the site review command, then open this page through the local preview server.'
}
