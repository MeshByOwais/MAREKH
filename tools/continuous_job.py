"""One isolated continuous-surface planning job. No saved assets are modified."""
import argparse
import copy
import json
import math
import os
from pathlib import Path
import shutil
import subprocess

from global_grade_bounds import ROOT, load_inputs, build_mesh, refine_mesh


def analytical_bounds(options, route, spacing):
    """Global relaxations, independent of portal resolution or corridor choice.

    Net elevation change and the 3D endpoint chord relax all terrain hazards.
    """
    a=route['outbound']['points'][0]; b=route['outbound']['points'][-1]
    dz=abs(b['elevationM']-a['elevationM'])
    chord=math.hypot(spacing*math.hypot(b['row']-a['row'],b['column']-a['column']),dz)
    grade_lower=max(0.,math.degrees(math.asin(min(1.,2*dz/options['roundTripBudgetM'])))-1e-7)
    cap=route['metrics']['maxAbsGradeDeg'] if options['objective']=='gentlest' else options['gradeLimitDeg']
    distance_lower=max(0.,2*max(chord,dz/math.sin(math.radians(max(cap,1e-10))))-1e-5)
    return dict(gradeLowerDeg=grade_lower,gradeUpperDeg=route['metrics']['maxAbsGradeDeg'],
                distanceLowerM=distance_lower,distanceUpperM=route['metrics']['distanceM'],exactOptimumClaimed=False,
                method='Endpoint elevation and 3D chord relaxations; conservative numerical margins.',
                scope='Global lower bounds on the continuous native surface; candidate upper bounds. Grade bracket concerns minimum peak grade within this distance budget. Distance bracket uses the selected peak cap; for gentlest, it uses the candidate peak cap. No tight gap or exact optimum is claimed.')


def run_job(work):
    from polish_global_route import polish
    work=Path(work);request=json.loads((work/'request.json').read_text())
    bun=os.environ.get('MAREKH_BUN') or shutil.which('bun') or str(Path.home()/'.bun/bin/bun')
    def package(prepare=False):
        subprocess.run([bun,str(ROOT/'tools/package_continuous_plan.ts'),str(work)]+(['--prepare'] if prepare else []),check=True,cwd=ROOT)
    print('Checking staging, native terrain and crew clearance…',flush=True);package(True)
    m,crew,base,z,blocked=load_inputs();crew=copy.deepcopy(crew);crew['staging']['cell']=request['start']
    config={**base,'roundTripBudgetM':request['roundTripBudgetM'],'portalElevationStepM':.005}
    inputs=(m,crew,config,z,blocked)
    start=request['start'];goal=crew['approach']['cell'];spacing=m['transform'][1]
    chord=math.hypot(spacing*math.hypot(start['row']-goal['row'],start['column']-goal['column']),float(z[start['row'],start['column']]-z[goal['row'],goal['column']]))
    if chord<1e-6:raise ValueError('Choose a staging point distinct from the science approach.')
    if 2*chord>=request['roundTripBudgetM']-1e-5:raise ValueError('The distance budget is no greater than the straight-line round trip. Increase the total distance limit.')
    print('Building the native triangle search area…',flush=True);build_mesh(inputs,work,upper_only=True)
    binary=ROOT/'data/work/dynamic/global_grade_portals'
    source=ROOT/'tools/global_grade_portals.cpp'
    if not binary.exists() or binary.stat().st_mtime<source.stat().st_mtime:
        binary.parent.mkdir(parents=True,exist_ok=True)
        subprocess.run(['g++','-O3','-std=c++17',str(source),'-o',str(binary)],check=True)
    def search(step,cap,minimax=False):
        subprocess.run([str(binary),str(work),str(step),'gentlest' if minimax else 'shortest',str(cap),'.005'],check=True)
    objective=request['objective'];cap=request['gradeLimitDeg']
    print('Searching continuous directions through elevation portals…',flush=True)
    search(.005,20 if objective=='gentlest' else cap,objective=='gentlest')
    print('Refining portal crossings near the candidate corridor…',flush=True)
    coarse=(work/'witness.json').read_bytes();refine_mesh(8,work)
    try:search(.001,20 if objective=='gentlest' else cap,objective=='gentlest')
    except subprocess.CalledProcessError:(work/'witness.json').write_bytes(coarse)
    print('Moving crossings continuously within native terrain faces…',flush=True)
    before=(work/'witness.json').read_bytes()
    try:polish(inputs,work,minimize_grade=objective=='gentlest',tolerance=.001)
    except RuntimeError:
        print('Continuous polish retained the feasible portal candidate.',flush=True)
        (work/'witness.json').write_bytes(before)
    print('Rechecking the route on both legs…',flush=True)
    try:package()
    except subprocess.CalledProcessError:
        # Projection onto a fixed corridor can create numerically delicate
        # collapsed pieces. A fully checked portal witness is the only fallback.
        print('Rechecking the original portal witness after a polish check failure…',flush=True)
        (work/'witness.json').write_bytes(before);package()
    result=json.loads((work/'result.json').read_text())
    result['continuousOptimalityBounds']=analytical_bounds(request,result['routes'][0],spacing)
    result['searchScope']='Elevation-portal A* followed by continuous conic improvement in selected native faces; no exact continuous optimum claimed.'
    (work/'result.json').write_text(json.dumps(result))
    print('Independent geometry, grade, footprint and swept-clearance audit…',flush=True)
    from validate_live_plan import validate
    result['audit']=validate(work/'result.json');result['independentAudit']=True;result['status']='independently-checked-live-plan'
    (work/'result.json').write_text(json.dumps(result));print('Plan checked and ready.',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('work');args=parser.parse_args()
    try:run_job(args.work)
    except Exception as error:
        print(f'Planning failed: {error}',flush=True)
        raise
