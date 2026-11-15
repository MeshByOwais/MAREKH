import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from planner_cache import PlanCache
import serve_planner as server


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        for name in ('src','tools','config','public/sites'):(self.root/name).mkdir(parents=True)
        self.asset=self.root/'public/sites/elevation.f32';self.asset.write_bytes(b'original terrain')
        self.request=dict(start=dict(row=370,column=406),objective='gentlest',roundTripBudgetM=500,gradeLimitDeg=3)
        self.cache=PlanCache(self.root)
    def tearDown(self):self.temp.cleanup()

    def test_exact_inputs_persist_without_rounding_different_limits(self):
        key=self.cache.key(self.request);result=dict(independentAudit=True,routes=[{'distanceM':498.123}])
        self.cache.put(key,result)
        self.assertEqual(PlanCache(self.root).get(key),result)
        self.assertEqual(key,self.cache.key({**self.request,'roundTripBudgetM':500.0}))
        for change in [dict(roundTripBudgetM=500.00001),dict(gradeLimitDeg=4),dict(objective='shortest-peak'),dict(start=dict(row=371,column=406))]:
            self.assertNotEqual(key,self.cache.key({**self.request,**change}))

    def test_terrain_rules_code_and_dependency_changes_invalidate(self):
        for path in [self.asset,self.root/'config/rules.json',self.root/'tools/solver.py',self.root/'src/audit.ts',self.root/'data/work/global-python/solver.py']:
            before=self.cache.key(self.request);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'changed')
            self.assertNotEqual(before,self.cache.key(self.request))

    def test_unchecked_and_damaged_records_are_never_reused(self):
        key=self.cache.key(self.request);self.cache.put(key,dict(independentAudit=False));self.assertIsNone(self.cache.get(key))
        self.cache.put(key,dict(independentAudit=True,routes=[]));path=self.cache.directory/f'{key}.json'
        record=json.loads(path.read_text());record['result']['routes']=['corrupted'];path.write_text(json.dumps(record))
        self.assertIsNone(self.cache.get(key));path.write_text('broken JSON');self.assertIsNone(self.cache.get(key))

    def test_http_reuses_active_and_persisted_checked_jobs(self):
        server.JOBS.clear()
        with patch.object(server,'ROOT',self.root),patch.object(server,'CACHE',self.cache),patch.object(server,'execute') as execute:
            http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
            thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
            url=f'http://127.0.0.1:{http.server_port}/api/plans'
            def post(data):
                with urlopen(Request(url,json.dumps(data).encode(),{'Content-Type':'application/json'})) as response:return json.load(response)
            try:
                first=post(self.request);again=post(self.request)
                self.assertEqual(first['id'],again['id']);self.assertTrue(again['reused'])
                with self.assertRaises(HTTPError) as caught:post({**self.request,'gradeLimitDeg':4})
                self.assertEqual(caught.exception.code,409)
                self.assertEqual(execute.call_count,1)
                server.JOBS[first['id']]['state']='cancelled'
                fresh=post(self.request);self.assertNotEqual(fresh['id'],first['id'])
                server.JOBS.clear();result=dict(independentAudit=True,routes=[{'distanceM':499}]);self.cache.put(self.cache.key(self.request),result)
                hit=post(self.request);self.assertEqual(hit['state'],'done')
                with urlopen(url+'/'+hit['id']) as response:self.assertEqual(json.load(response)['result'],result)
                self.assertEqual(execute.call_count,2)
            finally:http.shutdown();http.server_close();thread.join();server.JOBS.clear()


if __name__=='__main__':unittest.main()
