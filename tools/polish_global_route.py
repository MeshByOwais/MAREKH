"""Continuous upper-witness improvement in a fixed face/turn corridor.

This convex subproblem does not certify a global optimum. The native audit and
independent global lower potential remain the authorities on saved bounds.
"""
import json
import math

import clarabel
import numpy as np
from scipy.sparse import coo_matrix, csc_matrix
from global_grade_bounds import WORK, load_inputs


def polish(inputs=None, work=WORK, minimize_grade=True, tolerance=.0001):
    manifest,_,config,z,blocked=inputs or load_inputs();spacing=manifest['transform'][1]
    w=json.loads((work/'witness.json').read_text());original=np.array([[p['row'],p['column']] for p in w['points']])
    (work/'portal-witness.json').write_text(json.dumps(w)+'\n')
    n=len(original);nv=2*n+n-1;faces=[]
    for a,b in zip(original[:-1],original[1:]):
        mid=(a+b)/2;found=None
        for r in range(math.floor(mid[0])-1,math.floor(mid[0])+1):
            for c in range(math.floor(mid[1])-1,math.floor(mid[1])+1):
                if r<0 or c<0 or r>=z.shape[0]-1 or c>=z.shape[1]-1 or blocked[r:r+2,c:c+2].any():continue
                for tri in [0,1]:
                    A=np.array([[-1,0],[0,-1],[1,1]]) if tri==0 else np.array([[1,0],[0,1],[-1,-1]])
                    rhs=np.array([-r,-c,r+c+1]) if tri==0 else np.array([r+1,c+1,-r-c-1])
                    if np.all(A@a<=rhs+1e-8) and np.all(A@b<=rhs+1e-8):
                        vertices={(r,c),(r,c+1),(r+1,c)} if tri==0 else {(r+1,c+1),(r+1,c),(r,c+1)}
                        grad=np.array([z[r+1,c]-z[r,c],z[r,c+1]-z[r,c]]) if tri==0 else np.array([z[r+1,c+1]-z[r,c+1],z[r+1,c+1]-z[r+1,c]])
                        found=(A,rhs,vertices,grad);break
                if found:break
            if found:break
        if found is None:raise RuntimeError('Portal segment has no cleared native face')
        faces.append(found)
    def solve(cap):
        rows=[];cols=[];values=[];rhs=[]
        def add(coeff,b):
            row=len(rhs);rhs.append(float(b))
            for col,v in coeff.items():
                if v:rows.append(row);cols.append(col);values.append(float(v))
        for i in [0,n-1]:
            for k in [0,1]:add({2*i+k:1},0)
        for i,(A,b,_,_) in enumerate(faces):
            for j in [i,i+1]:
                for direction,limit in zip(A,b):add({2*j:direction[0],2*j+1:direction[1]},limit-direction@original[j])
        for i,(_,_,_,g) in enumerate(faces):
            magnitude=np.linalg.norm(g)/spacing;alpha=math.atan(magnitude)
            theta=math.radians(max(1e-8,cap-1e-5))
            if alpha<=theta:continue
            up=g/np.linalg.norm(g);cross=np.array([-up[1],up[0]])
            a=math.sin(theta)/math.sin(alpha);k=a/math.sqrt(1-a*a)
            sign=1 if cross@(original[i+1]-original[i])>=0 else -1
            for su in [-1,1]:
                direction=su*up*math.sqrt(1+magnitude*magnitude)-k*sign*cross
                add({2*i:-direction[0],2*i+1:-direction[1],2*(i+1):direction[0],2*(i+1)+1:direction[1]},-direction@(original[i+1]-original[i]))
        inequalities=len(rhs)-4
        for i,(_,_,_,g) in enumerate(faces):
            add({2*n+i:-1},0)
            for direction in [np.array([spacing,0]),np.array([0,spacing]),g]:
                # b-A*x = original displacement + endpoint displacement updates.
                add({2*i:direction[0],2*i+1:direction[1],2*(i+1):-direction[0],2*(i+1)+1:-direction[1]},direction@(original[i+1]-original[i]))
        A=coo_matrix((values,(rows,cols)),shape=(len(rhs),nv)).tocsc();objective=np.zeros(nv);objective[2*n:]=1
        settings=clarabel.DefaultSettings();settings.verbose=False;settings.tol_gap_abs=1e-7;settings.tol_feas=1e-10;settings.tol_gap_rel=1e-9;settings.max_iter=150
        solution=clarabel.DefaultSolver(csc_matrix((nv,nv)),objective,A,np.array(rhs),[clarabel.ZeroConeT(4),clarabel.NonnegativeConeT(inequalities)]+[clarabel.SecondOrderConeT(4) for _ in faces],settings).solve()
        if str(solution.status) not in ['Solved','AlmostSolved']:
            print(json.dumps(dict(cap=cap,status=str(solution.status))),flush=True);return None
        points=original+np.array(solution.x[:2*n]).reshape(n,2);points[0]=original[0];points[-1]=original[-1]
        for i in range(1,n-1):
            common=faces[i-1][2]&faces[i][2]
            if len(common)==1:points[i]=next(iter(common))
            elif len(common)==2:
                a,b=np.array(sorted(common),float);v=b-a;t=np.clip((points[i]-a)@v/(v@v),0,1);points[i]=a+t*v
            elif len(common)==3:
                # A minute interior slack avoids roundoff outside the triangle.
                vertices=np.array(sorted(common),float);matrix=np.column_stack([vertices[1]-vertices[0],vertices[2]-vertices[0]])
                uv=np.linalg.solve(matrix,points[i]-vertices[0]);weights=np.maximum(0,[1-uv.sum(),*uv]);weights/=sum(weights);points[i]=weights@vertices
            else:raise RuntimeError('Nonadjacent face sequence')
        length=0.;peak=0.
        for i,(_,_,_,g) in enumerate(faces):
            delta=points[i+1]-points[i];h=spacing*np.linalg.norm(delta);dz=g@delta
            if h<1e-8:continue
            length+=math.hypot(h,dz);peak=max(peak,math.degrees(math.atan2(abs(dz),h)))
        if peak>cap+1e-7 or length>config['roundTripBudgetM']/2-1e-6:return None
        return points,length,peak
    low=0.;high=w['gradeCapDeg'];best=solve(high+.0001 if minimize_grade else high)
    if best is None:raise RuntimeError('Could not retain a feasible corridor witness; original route unchanged')
    while minimize_grade and high-low>tolerance:
        mid=(low+high)/2;candidate=solve(mid)
        print(json.dumps(dict(capDeg=mid,oneWayM=None if candidate is None else candidate[1])),flush=True)
        if candidate is None:low=mid
        else:high=mid;best=candidate
    points,length,peak=best;kept=[points[0]]
    for p in points[1:]:
        if np.linalg.norm(p-kept[-1])>1e-8:kept.append(p)
    declared_cap=math.ceil(max(high,peak+1e-7)*1000)/1000 if minimize_grade else high
    w.update(needsGradeRealization=False,gradeCapDeg=declared_cap,oneWayDistanceM=length,points=[dict(row=float(p[0]),column=float(p[1])) for p in kept],polishEngine='fixed-face-branch-conic-1',unpolishedGradeCapDeg=w['gradeCapDeg'])
    (work/'witness.json').write_text(json.dumps(w,indent=2)+'\n');print(json.dumps({k:v for k,v in w.items() if k!='points'}),flush=True)


if __name__=='__main__':polish()
