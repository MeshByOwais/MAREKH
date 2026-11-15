import copy
import contextlib
import io
import json
import math
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from validate_global_routes import maximum_derivative, check_certificate, check_domain, validate
from global_grade_bounds import domain_bounds


class ContinuousBoundTests(unittest.TestCase):
    def test_flat_surface_all_directions(self):
        r,c=np.mgrid[:4,:5];phi=3*r+4*c
        self.assertAlmostEqual(maximum_derivative(phi,np.zeros_like(phi),1.,.1),5.)

    def test_vertical_potential_on_tilted_surface(self):
        r,c=np.mgrid[:4,:5];z=.1*r+.2*c
        phi=z/math.sin(math.radians(5))
        self.assertAlmostEqual(maximum_derivative(phi,z,1.,5),1.,places=8)

    def test_analytical_bound_dominates_dense_heading_oracle(self):
        rng=np.random.default_rng(7419);r,c=np.mgrid[:3,:3]
        headings=np.arange(200000)*2*math.pi/200000
        vr,vc=np.cos(headings),np.sin(headings)
        for _ in range(12):
            zr,zc=rng.uniform(-.4,.4,2);pr,pc=rng.uniform(-2,2,2);cap=rng.uniform(1,15)
            z=zr*r+zc*c;phi=pr*r+pc*c
            dz=zr*vr+zc*vc;allowed=np.abs(dz)<=math.tan(math.radians(cap))
            sampled=np.max(np.abs(pr*vr[allowed]+pc*vc[allowed])/np.hypot(1,dz[allowed]))
            exact=maximum_derivative(phi,z,1.,cap)
            self.assertLessEqual(sampled,exact+1e-9);self.assertLess(exact-sampled,.001)

    def fixture(self):
        r,c=np.mgrid[:4,:5];z=.1*r+.2*c;phi=z/math.sin(math.radians(5))*(1-1e-8)
        value=float(phi[3,4]-phi[0,0])-1e-5
        cert=dict(gradeDeg=5,oneWayDistanceLowerM=value,roundTripDistanceLowerM=2*value)
        return cert,phi,z

    def test_valid_continuous_certificate(self):
        cert,phi,z=self.fixture();report=check_certificate(cert,phi,z,1.,(3,4),(0,0),1e-5)
        self.assertLess(report['maximumAllowedDirectionalDerivative'],1)

    def test_reject_steep_potential_and_nonfinite_data(self):
        cert,phi,z=self.fixture()
        with self.assertRaises(AssertionError):check_certificate(cert,phi*1.001,z,1.,(3,4),(0,0),1e-5)
        phi[1,1]=np.nan
        with self.assertRaises(AssertionError):check_certificate(cert,phi,z,1.,(3,4),(0,0),1e-5)

    def test_reject_invented_distance_lower_bound(self):
        cert,phi,z=self.fixture();cert['oneWayDistanceLowerM']+=1
        with self.assertRaises(AssertionError):check_certificate(cert,phi,z,1.,(3,4),(0,0),1e-5)

    def test_budget_ellipse_contains_every_eligible_path(self):
        start,goal=(100,100),(180,190);spacing=1.;budget=160
        bounds=domain_bounds(start,goal,spacing,budget,(500,500));r0,r1,c0,c1=bounds
        domain=dict(bounds=bounds,vertexCount=(r1-r0+1)*(c1-c0+1),lowerFaceCount=2*(r1-r0)*(c1-c0),oneWayBudgetM=budget,spacingM=spacing,startIndex=(start[0]-r0)*(c1-c0+1)+start[1]-c0,goalIndex=(goal[0]-r0)*(c1-c0+1)+goal[1]-c0)
        check_domain(domain,start,goal,spacing,budget,(500,500))
        broken=copy.deepcopy(domain);broken['bounds'][0]+=20
        with self.assertRaises(AssertionError):check_domain(broken,start,goal,spacing,budget,(500,500))

    def test_saved_package_native_geometry_and_global_bounds(self):
        with contextlib.redirect_stdout(io.StringIO()):report=validate()
        self.assertEqual(report['status'],'passed')
        self.assertFalse(report['bounds']['exactOptimumClaimed'])
        self.assertLessEqual(report['bounds']['secondaryDistanceUpperM'],500)
        self.assertGreater(report['bounds']['gradeLowerDeg'],0)
        self.assertGreater(report['certificateSourceCheckedCells'],40000)


if __name__=='__main__':unittest.main()
