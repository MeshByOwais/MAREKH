"""Audit a downloaded Phase 4 plan using the existing independent checkers."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from validate_routes import check_footprint, check_leg, close
from validate_crew_routes import rebuild_assessment, validate_leg

ROOT = Path(__file__).resolve().parents[1]


def validate(path):
    result = json.loads(Path(path).read_text())
    terrain = ROOT / 'public/sites/columbia-hills/terrain-v1'
    manifest = json.loads((terrain / 'manifest.json').read_text())
    assert result['schemaVersion'] == 1 and result['datasetVersion'] == manifest['datasetVersion']
    assert result['mode'] in ('crew', 'baseline', 'continuous')
    continuous = result['mode'] == 'continuous'
    crew = result['mode'] != 'baseline'
    if not continuous:
        assert result['continuousOptimalityBounds'] is None
    config = result['config']; rules = config['rules']; t = manifest['transform']
    # Pin the rules to the selected versioned engine; only staging may change.
    name = 'crew-navigation-v1' if crew else 'routes-v1'
    original = json.loads((ROOT / f'public/sites/columbia-hills/{name}/config.json').read_text())
    original['staging']['cell'] = result['staging']['cell']
    assert config == original
    arrays = []
    for name, dtype in [('elevation.f32', '<f4'), ('slope-deg.f32', '<f4'), ('coverage.u8', 'u1'), ('exclusions.u8', 'u1')]:
        data = (terrain / name).read_bytes()
        assert len(data) == manifest['assets'][name]['bytes'] and hashlib.sha256(data).hexdigest() == manifest['assets'][name]['sha256']
        arrays.append(np.frombuffer(data, dtype=dtype).reshape(manifest['rows'], manifest['columns']))
    if crew:
        rms, _, hazard, blocked = rebuild_assessment(arrays, rules, config['crewModel'], t[1])
        # The route engine stores the assessed RMS in Float32 before costs.
        density = 1 + rules['gentleWeight']*(arrays[1].astype(float)/rules['routeSlopeLimitDeg'])**2 + config['crewModel']['roughnessWeight']*(rms.astype('float32').astype(float)/config['crewModel']['roughnessRmsLimitM'])**2
    for name, limit in [('staging', rules['stagingSlopeLimitDeg']), ('approach', rules['routeSlopeLimitDeg'])]:
        cells = check_footprint(result[name], config[name], arrays, t, limit)
        if crew:
            assert all(not hazard[p] for p in cells)
    routes = result['routes']
    expected = {'minimax-grade', 'shortest-peak'} if continuous else {'distance', 'terrain'} if crew else {'shortest', 'gentle'}
    assert len(routes) == (1 if continuous else 2) and {r['policy'] for r in routes} <= expected
    if not continuous:
        assert {r['policy'] for r in routes} == expected
    pieces = 0
    for route in routes:
        assert route['start'] == config['staging']['cell'] and route['target'] == config['approach']['cell']
        assert route['datasetVersion'] == manifest['datasetVersion'] and route['status'] == 'ok'
        out, back = route['outbound']['points'], route['returnLeg']['points']
        assert len(out) == len(back)
        # Re-splitting native pieces in reverse can shift coordinates by <1 nm.
        for a, b in zip(out, reversed(back)):
            close(a['row'], b['row']); close(a['column'], b['column'])
        assert {k: out[0][k] for k in ('row', 'column')} == route['start']
        assert {k: out[-1][k] for k in ('row', 'column')} == route['target']
        assert route['scienceWaypointIndex'] == len(out)-1
        close(route['turnaroundDistanceM'], out[-1]['cumulativeDistanceM'])
        metrics = []
        for leg in ('outbound', 'returnLeg'):
            if crew:
                checked = validate_leg(route[leg], 'distance' if continuous else route['policy'], arrays, blocked, hazard, density, t, config)
            else:
                checked = check_leg(route[leg], route['policy'], arrays, t, rules)
            metrics.append(checked[0]); pieces += len(route[leg]['points'])-1
        for key in metrics[0]:
            if key == 'estimatedTimeS':
                assert route['metrics'][key] is None
            else:
                expected_value = max(m[key] for m in metrics) if key.startswith('max') else sum(m[key] for m in metrics)
                close(route['metrics'][key], expected_value)
        if continuous:
            assert route['engine'] == 'native-portals-conic-live-1'
            options = result['options']; budget = options['roundTripBudgetM']; cap = options['gradeLimitDeg']
            assert options['start'] == route['start']
            assert 10 <= budget <= 1200 and .05 <= cap <= rules['moveGradeLimitDeg']
            expected_policy = 'minimax-grade' if options['objective'] == 'gentlest' else options['objective']
            assert route['policy'] == expected_policy
            assert route['metrics']['distanceM'] <= budget + 1e-7
            weight = distance = 0.
            for leg in (out, back):
                for a, b in zip(leg[:-1], leg[1:]):
                    horizontal = math.dist((a['row'], a['column']), (b['row'], b['column']))*t[1]
                    dz = b['elevationM']-a['elevationM']; d = math.hypot(horizontal, dz)
                    weight += d*abs(math.degrees(math.atan2(dz, horizontal))); distance += d
            average = weight/distance
            close(average, route['metrics']['averageAbsGradeDeg'])
            if options['objective'] == 'shortest-peak': assert route['metrics']['maxAbsGradeDeg'] <= cap+1e-7
            bounds = result['continuousOptimalityBounds']
            assert isinstance(bounds, dict)
            if bounds is not None:
                a, b = out[0], out[-1]
                dz = abs(b['elevationM']-a['elevationM'])
                chord = math.sqrt(((b['row']-a['row'])*t[1])**2+((b['column']-a['column'])*t[1])**2+dz**2)
                lower_grade = max(0.,math.asin(min(1.,2*dz/budget))*180/math.pi-1e-7)
                chosen_cap = route['metrics']['maxAbsGradeDeg'] if options['objective']=='gentlest' else cap
                lower_distance = max(0.,2*max(chord,dz/math.sin(max(chosen_cap,1e-10)*math.pi/180))-1e-5)
                assert bounds['exactOptimumClaimed'] is False
                close(bounds['gradeLowerDeg'],lower_grade);close(bounds['gradeUpperDeg'],route['metrics']['maxAbsGradeDeg'])
                close(bounds['distanceLowerM'],lower_distance);close(bounds['distanceUpperM'],route['metrics']['distanceM'])
                assert lower_distance <= route['metrics']['distanceM']+1e-7
                assert lower_grade <= route['metrics']['maxAbsGradeDeg']+1e-7

    report = dict(status='passed', mode=result['mode'], staging=result['staging']['cell'], checkedPieces=pieces, checker='Independent Python geometry, native arrays, footprint and full swept crew clearance where applicable', scope='Live native geometry and constraints; analytical bounds only for continuous jobs, no newly generated conic lower potential')
    print(json.dumps(report, indent=2))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('plan')
    validate(parser.parse_args().plan)
