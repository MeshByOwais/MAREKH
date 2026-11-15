import { computeLivePlan, type LiveRequest, type LiveMessage } from './interactive.ts'
const worker = self as unknown as { onmessage: ((event: MessageEvent<LiveRequest>) => void) | null; postMessage(message: LiveMessage): void }
worker.onmessage = ({data}) => {
  try {
    const plan=computeLivePlan(data,text=>worker.postMessage({id:data.id,type:'progress',text}))
    worker.postMessage({id:data.id,type:'result',plan})
  } catch(error) {
    worker.postMessage({id:data.id,type:'error',text:error instanceof Error?error.message:'Search failed.'})
  }
}
