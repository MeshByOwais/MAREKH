"""Local static preview plus isolated, cancellable continuous planning jobs."""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

ROOT=Path(__file__).resolve().parents[1]
JOBS={};LOCK=threading.Lock()


def validate_request(data):
    if not isinstance(data,dict) or set(data)!={'start','objective','roundTripBudgetM','gradeLimitDeg'}:raise ValueError('Invalid planning request fields.')
    if data['objective'] not in ('gentlest','shortest-peak'):raise ValueError('Unknown route objective.')
    if not isinstance(data['start'],dict) or set(data['start'])!={'row','column'}:raise ValueError('Invalid start cell.')
    for value in data['start'].values():
        if type(value) is not int or not 0<=value<990:raise ValueError('Staging must be an integer native cell inside the map.')
    for key,lo,hi in [('roundTripBudgetM',10,1200),('gradeLimitDeg',.05,20)]:
        value=data[key]
        if type(value) not in (int,float) or not math.isfinite(value) or not lo<=value<=hi:raise ValueError(f'{key} must be between {lo} and {hi}.')
    return data


def terminate(job):
    process=job.get('process')
    if process and process.poll() is None:
        try:os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError:pass


def execute(job):
    env=os.environ.copy();deps=ROOT/'data/work/global-python'
    if deps.is_dir():env['PYTHONPATH']=str(deps)+os.pathsep+env.get('PYTHONPATH','')
    try:
        with LOCK:
            if job['state']=='cancelled':return
            process=subprocess.Popen([os.environ.get('COLUMBIA_GDAL_PYTHON','/usr/bin/python3'),str(ROOT/'tools/continuous_job.py'),str(job['work'])],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
            job['process']=process
        def deadline():
            with LOCK:
                if job['state']=='running':job.update(state='error',text='Search reached its ten-minute resource limit. No route was applied; continuous infeasibility is not established.');terminate(job)
        timer=threading.Timer(600,deadline);timer.daemon=True;timer.start()
        with (job['work']/'search.log').open('w') as log:
            for line in process.stdout:
                log.write(line);log.flush();line=line.strip()
                if line.startswith('Planning failed:'):
                    job['failure']=line.removeprefix('Planning failed:').strip()
                if line.startswith(('Checking ','Building ','Searching ','Refining ','Moving ','Rechecking ','Independent ','Plan checked','Continuous polish')):
                    with LOCK:
                        if job['state']=='running':job['text']=line[-450:]
        code=process.wait();timer.cancel()
        with LOCK:
            if job['state']!='running':return
            if code==0:
                result=json.loads((job['work']/'result.json').read_text())
                if result.get('independentAudit') is not True:raise RuntimeError('Independent check did not finish.')
                job.update(state='done',text='Plan checked and ready.',result=result)
            else:job.update(state='error',text='Search did not produce a checked route. '+job.get('failure',job['text']))
    except Exception as error:
        with LOCK:
            if job['state']=='running':job.update(state='error',text=f'Planner could not finish: {error}')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT/'dist'),**kwargs)
    def list_directory(self,path):self.send_error(404)
    def respond(self,code,data):
        body=json.dumps(data).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def allowed(self):
        host=self.headers.get('Host','');origin=self.headers.get('Origin')
        return host in (f'127.0.0.1:{self.server.server_port}',f'localhost:{self.server.server_port}') and (origin is None or origin in (f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'))
    def do_GET(self):
        path=urlparse(self.path).path
        if not path.startswith('/api/'):return super().do_GET()
        if not self.allowed():return self.respond(403,{'error':'Local planner origin required.'})
        if path=='/api/planner':return self.respond(200,{'available':True,'engine':'native-portals-conic-live-1','maximumRoundTripM':1200})
        with LOCK:
            job=JOBS.get(path.removeprefix('/api/plans/'))
            if job is None:return self.respond(404,{'error':'Planning job not found.'})
            data={k:job[k] for k in ('id','state','text')}
            if job['state']=='done':data['result']=job['result']
        return self.respond(200,data)
    def do_POST(self):
        if not self.allowed():return self.respond(403,{'error':'Local planner origin required.'})
        if self.path!='/api/plans':return self.respond(404,{'error':'Unknown endpoint.'})
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=2048:raise ValueError('Invalid request size.')
            request=validate_request(json.loads(self.rfile.read(size)))
        except (ValueError,TypeError) as error:return self.respond(400,{'error':str(error)})
        with LOCK:
            if any(j['state']=='running' for j in JOBS.values()):return self.respond(409,{'error':'Another continuous search is running. Cancel it or wait for it to finish.'})
            key=uuid.uuid4().hex;work=ROOT/'data/work/dynamic'/key;work.mkdir(parents=True)
            (work/'request.json').write_text(json.dumps(request))
            job=dict(id=key,state='running',text='Preparing continuous terrain search…',work=work,created=time.monotonic());JOBS[key]=job
            # Keep recent job results addressable for pending browser polls.
            for old in sorted(JOBS.values(),key=lambda j:j['created'])[:-20]:JOBS.pop(old['id'])
        threading.Thread(target=execute,args=(job,),daemon=True).start()
        return self.respond(202,{'id':key,'state':'running'})
    def do_DELETE(self):
        if not self.allowed():return self.respond(403,{'error':'Local planner origin required.'})
        with LOCK:
            job=JOBS.get(urlparse(self.path).path.removeprefix('/api/plans/'))
            if job is None:return self.respond(404,{'error':'Planning job not found.'})
            if job['state']=='running':job.update(state='cancelled',text='Search cancelled.');terminate(job)
        return self.respond(200,{'state':job['state']})


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=4175);args=parser.parse_args()
    if not (ROOT/'dist/index.html').exists():raise SystemExit('Build the app before starting the local planner.')
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'MAREKH continuous planner: http://127.0.0.1:{args.port}',flush=True)
    try:server.serve_forever()
    finally:
        with LOCK:
            for job in JOBS.values():terminate(job)
        server.server_close()
