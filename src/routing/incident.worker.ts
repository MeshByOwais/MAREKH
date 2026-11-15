import {computeIncidentChoices,type IncidentRequest,type IncidentMessage} from './incidents.ts'
const worker=self as unknown as {onmessage:((event:MessageEvent<IncidentRequest>)=>void)|null;postMessage(message:IncidentMessage):void}
worker.onmessage=({data})=>{try{const choices=computeIncidentChoices(data,text=>worker.postMessage({id:data.id,type:'progress',text}));worker.postMessage({id:data.id,type:'result',choices})}catch(error){worker.postMessage({id:data.id,type:'error',text:error instanceof Error?error.message:'Incident search failed.'})}}
