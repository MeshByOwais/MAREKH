// Release check of committed browser assets, without original rasters or GDAL.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
const base=new URL('../public/sites/columbia-hills/',import.meta.url)
const sha=b=>createHash('sha256').update(b).digest('hex')
const packages={}
let assets=0
for(const folder of ['synthetic','terrain-v1','routes-v1','crew-navigation-v1','global-grade-v1','science']){
  const bytes=await readFile(new URL(`${folder}/manifest.json`,base)),manifest=JSON.parse(bytes)
  packages[folder]={manifest,hash:sha(bytes)}
  for(const [name,record]of Object.entries(manifest.assets)){
    assert(!name.includes('/')&&!name.includes('..'),'Unsafe asset name')
    const bytes=await readFile(new URL(`${folder}/${name}`,base))
    assert.equal(bytes.length,record.bytes,`${folder}/${name} size`);assert.equal(sha(bytes),record.sha256,`${folder}/${name} hash`);assets++
  }
  if(['routes-v1','crew-navigation-v1','global-grade-v1'].includes(folder)){
    const audit=JSON.parse(await readFile(new URL(`${folder}/validation.json`,base)))
    assert.equal(audit.status,'passed');assert.equal(audit.datasetVersion,manifest.datasetVersion)
  }
}
for(const folder of ['routes-v1','crew-navigation-v1','global-grade-v1'])assert.equal(packages[folder].manifest.terrainManifestSha256,packages['terrain-v1'].hash)
assert.equal(packages['crew-navigation-v1'].manifest.baselineManifestSha256,packages['routes-v1'].hash)
assert.equal(packages['global-grade-v1'].manifest.crewManifestSha256,packages['crew-navigation-v1'].hash)
const sources=JSON.parse(await readFile(new URL('../config/columbia-hills/sources.json',import.meta.url)))
const observation=sources.references.find(record=>record.productId==='PIA11758'),science=packages.science.manifest
assert.equal(science.assets['PIA11758.jpg'].sha256,observation.sha256);assert.equal(science.credit,observation.credits);assert.equal(science.observedOn,observation.observationDate)
console.log(`Prepared release verified: ${assets} hashed assets, matching terrain/route versions and credited science image. Original source audit remains bun run build.`)
