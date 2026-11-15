import {test,expect} from 'bun:test'
import {readFileSync} from 'node:fs'
import {validateMission} from '../src/mission/config.ts'
const mission=JSON.parse(readFileSync(new URL('../public/missions/columbia-hills.json',import.meta.url),'utf8'))
test('mission identity, assets, models and science can be changed through a descriptor',()=>{
  const alternate={...mission,id:'editor-fixture',name:'Editor fixture',terrain:'../fixture/terrain/',defaultModel:'crew',continuousServiceMission:null,packages:{crew:{path:'../fixture/routes/',version:'editor-routes-1'}},science:{...mission.science,title:'Another source-linked stop'}}
  expect(validateMission(alternate).id).toBe('editor-fixture');expect(validateMission(alternate).science.title).toBe('Another source-linked stop')
})
test('incomplete missions, missing models and executable source links are rejected',()=>{
  for(const change of [{schemaVersion:2},{packages:{}},{defaultModel:'missing'},{science:{...mission.science,source:'javascript:alert(1)'}}])expect(()=>validateMission({...mission,...change})).toThrow()
})
