import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path
import numpy as np

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
import validate_crew_routes as audit


class CrewNavigationAudit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p=ROOT/'public/sites/columbia-hills';cls.manifest=json.loads((p/'terrain-v1/manifest.json').read_text());cls.t=cls.manifest['transform'];shape=cls.manifest['rows'],cls.manifest['columns']
        cls.arrays=tuple(np.fromfile(p/'terrain-v1'/name,dtype=dtype).reshape(shape) for name,dtype in [('elevation.f32','<f4'),('slope-deg.f32','<f4'),('coverage.u8','u1'),('exclusions.u8','u1')])
        cls.config=json.loads((p/'crew-navigation-v1/config.json').read_text());cls.leg=json.loads((p/'crew-navigation-v1/routes.json').read_text())['routes'][0]['outbound']
        cls.blocked=np.fromfile(p/'crew-navigation-v1/clearance-blocked.u8',dtype='u1').reshape(shape);cls.hazard=np.fromfile(p/'crew-navigation-v1/hazard.u8',dtype='u1').reshape(shape)
        rms=np.fromfile(p/'crew-navigation-v1/roughness-rms.f32',dtype='<f4').reshape(shape)
        cls.density=1+4*(cls.arrays[1].astype(float)/20)**2+2*(rms.astype(float)/.1)**2

    def test_complete_native_source_and_swept_clearance_audit(self):
        self.assertEqual(audit.validate()['status'],'passed')

    def test_segment_box_geometry_includes_exact_corner_contact(self):
        self.assertEqual(audit.segment_box_distance((0,0),(2,2),1,1),0)
        self.assertAlmostEqual(audit.segment_box_distance((0,0),(0,2),2,1),1.5)
        self.assertIn((1,0),audit.touched((0,0),(1,1),(3,3)))
        self.assertIn((0,1),audit.touched((0,0),(1,1),(3,3)))

    def test_independent_plane_fit_removes_a_slope_and_detects_a_bump(self):
        rr,cc=np.indices((9,9));z=.1*rr+.2*cc
        arrays=(z,np.ones((9,9)),np.ones((9,9),dtype='u1'),np.zeros((9,9),dtype='u1'))
        rms,_,hazard,_=audit.rebuild_assessment(arrays,self.config['rules'],self.config['crewModel'],1)
        self.assertLess(rms[4,4],1e-12);self.assertFalse(hazard[4,4])
        z[4,4]+=1;self.assertTrue(audit.rebuild_assessment(arrays,self.config['rules'],self.config['crewModel'],1)[2][4,4])

    def test_audit_rejects_tampered_continuous_positions_heights_and_metrics(self):
        for field in ['eastM','elevationM','segmentGradeDeg','cumulativeDistanceM']:
            leg=copy.deepcopy(self.leg);leg['points'][7][field]+=1
            with self.assertRaises(AssertionError):audit.validate_leg(leg,'distance',self.arrays,self.blocked,self.hazard,self.density,self.t,self.config)
        leg=copy.deepcopy(self.leg);leg['metrics']['positiveClimbM']+=1
        with self.assertRaises(AssertionError):audit.validate_leg(leg,'distance',self.arrays,self.blocked,self.hazard,self.density,self.t,self.config)

    def test_audit_rejects_swept_hazard_even_if_inflation_mask_is_tampered(self):
        leg=copy.deepcopy(self.leg);hazard=self.hazard.copy();p=leg['points'][0];hazard[int(p['row']),int(p['column'])]=1
        with self.assertRaisesRegex(AssertionError,'Swept crew footprint'):audit.validate_leg(leg,'distance',self.arrays,self.blocked,hazard,self.density,self.t,self.config)


if __name__=='__main__':unittest.main()
