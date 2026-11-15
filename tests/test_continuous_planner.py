import json
import contextlib
import io
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from serve_planner import validate_request
from continuous_job import analytical_bounds
from global_grade_bounds import domain_bounds, build_mesh


class ContinuousPlannerTests(unittest.TestCase):
    def request(self):return dict(start=dict(row=370,column=406),objective='gentlest',roundTripBudgetM=500,gradeLimitDeg=3)

    def test_reject_bad_requests_without_spawning_search(self):
        self.assertEqual(validate_request(self.request()),self.request())
        for key,bad in [('roundTripBudgetM',float('nan')),('roundTripBudgetM',1201),('gradeLimitDeg',True),('gradeLimitDeg',21),('start',dict(row=-1,column=5)),('start',dict(row=3.5,column=5)),('objective','unknown')]:
            request=self.request();request[key]=bad
            with self.assertRaises(ValueError):validate_request(request)

    def test_boundary_domain_contains_eligible_map_points(self):
        start=np.array([4,6]);goal=np.array([12,15]);budget=50
        r0,r1,c0,c1=domain_bounds(start,goal,1,budget,(40,40))
        for r in range(40):
            for c in range(40):
                p=np.array([r,c])
                if np.linalg.norm(p-start)+np.linalg.norm(p-goal)<=budget:self.assertTrue(r0<=r<=r1 and c0<=c<=c1)

    def test_live_mesh_keeps_missing_terrain_isolated_without_inventing_heights(self):
        z=np.zeros((7,7));z[0,0]=float('nan');blocked=np.zeros_like(z,dtype=bool);blocked[0,0]=True
        inputs=(dict(transform=[0,1,0,0,0,-1]),dict(staging=dict(cell=dict(row=2,column=2)),approach=dict(cell=dict(row=4,column=4))),dict(roundTripBudgetM=12,portalElevationStepM=.005),z,blocked)
        with tempfile.TemporaryDirectory() as folder,contextlib.redirect_stdout(io.StringIO()):
            work=Path(folder);record=build_mesh(inputs,work,upper_only=True)
            faces=np.fromfile(work/'upper-faces.i32','<i4');vertices=np.fromfile(work/'vertices.f64','<f8').reshape(-1,3)
            self.assertEqual(record['lowerFaceCount'],0);self.assertGreater(len(faces),0)
            self.assertTrue(np.isnan(vertices[:,2]).any());self.assertTrue(np.isfinite(vertices[faces,2]).all())

    def test_bounds_valid_on_known_planar_route_and_peak_constraint(self):
        grade=5;length=100;dz=length*math.sin(math.radians(grade));horizontal=length*math.cos(math.radians(grade))
        route=dict(outbound=dict(points=[dict(row=0,column=0,elevationM=0),dict(row=horizontal,column=0,elevationM=dz)]),metrics=dict(maxAbsGradeDeg=grade,distanceM=2*length))
        for objective in ['gentlest','shortest-peak']:
            options=dict(objective=objective,roundTripBudgetM=2*length,gradeLimitDeg=grade)
            bounds=analytical_bounds(options,route,1)
            self.assertLessEqual(bounds['gradeLowerDeg'],grade);self.assertGreater(bounds['gradeLowerDeg'],grade-1e-6)
            self.assertLessEqual(bounds['distanceLowerM'],2*length);self.assertGreater(bounds['distanceLowerM'],2*length-2e-5)
            self.assertFalse(bounds['exactOptimumClaimed'])


class PortalSearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.work=Path(cls.temp.name);cls.binary=cls.work/'portals'
        subprocess.run(['g++','-O2','-std=c++17',str(ROOT/'tools/global_grade_portals.cpp'),'-o',str(cls.binary)],check=True,capture_output=True)

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def mesh(self,gradient=0,budget=2):
        np.array([[0,0,0],[0,1,0],[1,0,gradient],[1,1,gradient]],dtype='<f8').tofile(self.work/'vertices.f64')
        np.array([[0,1,2],[3,2,1]],dtype='<i4').tofile(self.work/'upper-faces.i32')
        (self.work/'mesh.txt').write_text(f'4 2 0 3 1 {budget} .005\n')

    def test_fixed_cap_search_returns_actual_length_minimum_on_flat_fixture(self):
        self.mesh();subprocess.run([str(self.binary),str(self.work),'.005','shortest','3'],check=True,capture_output=True)
        w=json.loads((self.work/'witness.json').read_text())
        self.assertAlmostEqual(w['oneWayDistanceM'],math.sqrt(2),places=10);self.assertEqual(w['gradeCapDeg'],3)
        self.assertFalse(w['needsGradeRealization'])

    def test_minimax_retains_last_successful_witness_after_failed_grade_trials(self):
        self.mesh(.1,4)
        run=subprocess.run([str(self.binary),str(self.work),'.005','gentlest','20','.005'],check=True,capture_output=True,text=True)
        witness=json.loads((self.work/'witness.json').read_text())
        self.assertIn('m, ',run.stderr)  # Includes binary-search trials.
        self.assertAlmostEqual(witness['gradeCapDeg'],1.6845703125,places=10)
        self.assertLessEqual(witness['oneWayDistanceM'],4)
        self.assertEqual(witness['points'][0],dict(row=0,column=0))
        self.assertEqual(witness['points'][-1],dict(row=1,column=1))
        self.assertGreater(witness['expanded'],0)

    def test_budget_and_peak_cap_are_enforced_without_infeasibility_claim(self):
        self.mesh(.1,2)
        result=subprocess.run([str(self.binary),str(self.work),'.005','shortest','2'],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertIn('continuous infeasibility is not established',result.stderr)
        self.mesh(0,1)
        self.assertNotEqual(subprocess.run([str(self.binary),str(self.work),'.005','shortest','3'],capture_output=True).returncode,0)


if __name__=='__main__':unittest.main()
