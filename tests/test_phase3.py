import copy
import importlib.util
import json
import unittest

import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit', ROOT/'tools/validate_routes.py')
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)


class RouteAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p=ROOT/'public/sites/columbia-hills';cls.t=json.loads((p/'terrain-v1/manifest.json').read_text())
        shape=cls.t['rows'],cls.t['columns']
        cls.arrays=tuple(np.fromfile(p/'terrain-v1'/name,dtype=dtype).reshape(shape) for name,dtype in [('elevation.f32','<f4'),('slope-deg.f32','<f4'),('coverage.u8','u1'),('exclusions.u8','u1')])
        cls.rules=json.loads((p/'routes-v1/config.json').read_text())['rules']
        cls.route=json.loads((p/'routes-v1/routes.json').read_text())['routes'][0]

    def test_full_saved_package_and_gis(self):
        self.assertEqual(audit.validate()['status'],'passed')

    def test_independent_audit_rejects_position_and_metric_tampering(self):
        for field in ['eastM','elevationM','segmentGradeDeg','cumulativeDistanceM','edgeSurfaceSlopeDeg']:
            leg=copy.deepcopy(self.route['outbound']);leg['points'][5][field]+=1
            with self.assertRaises(AssertionError):audit.check_leg(leg,'shortest',self.arrays,self.t['transform'],self.rules)
        leg=copy.deepcopy(self.route['outbound']);leg['metrics']['positiveClimbM']+=1
        with self.assertRaises(AssertionError):audit.check_leg(leg,'shortest',self.arrays,self.t['transform'],self.rules)

    def test_independent_audit_rejects_excluded_and_unknown_corner(self):
        arrays=(np.zeros((2,2)),np.zeros((2,2)),np.ones((2,2),dtype='u1'),np.zeros((2,2),dtype='u1'))
        arrays[2][0,1]=0
        with self.assertRaises(AssertionError):audit.check_edge((0,0),(1,1),arrays,[0,1,0,0,0,-1],self.rules)
        arrays[2][0,1]=1;arrays[3][1,0]=1
        with self.assertRaises(AssertionError):audit.check_edge((0,0),(1,1),arrays,[0,1,0,0,0,-1],self.rules)

    def test_independent_audit_rejects_diagonal_cardinal_grade(self):
        arrays=(np.zeros((2,2)),np.zeros((2,2)),np.ones((2,2),dtype='u1'),np.zeros((2,2),dtype='u1'))
        arrays[0][1,1]=.5
        with self.assertRaises(AssertionError):audit.check_edge((0,0),(1,1),arrays,[0,1,0,0,0,-1],self.rules)


if __name__=='__main__':unittest.main()
