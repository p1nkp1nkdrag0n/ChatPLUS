"""Recompute the accompanying 2026-09-11 report offline, with no API calls.

Usage: python docs/reports/data/recompute-affinity-before-after.py
Requires only Python's standard library. The JSON contains the full visible
sample texts, both frozen AI reviews, input provenance, and audit summaries.
"""
import json
import math
import statistics
import unicodedata
from collections import Counter
from pathlib import Path

path = Path(__file__).with_name('2026-09-11-single-affinity-before-after.json')
data = json.loads(path.read_text(encoding='utf-8'))
rows = data['rows']
primary = data['design']['primaryScenes']
assert len(rows) == 198
assert sum(x['success'] for x in rows) == 197
assert len({(x['version'], x['sampleId']) for x in rows}) == 198
assert [(x['version'], x['sampleId']) for x in rows if not x['success']] == [
    ('historical', 'single_S03_center_r1')
]
for row in rows:
    if row['success']:
        count = len(''.join(unicodedata.normalize('NFC', row['text']).split()))
        assert count == row['nfcNonWhitespaceCodepoints'], row['sampleId']
    else:
        assert row['nfcNonWhitespaceCodepoints'] is None

means = {}
for version in ['historical', 'contemporary_old_wire', 'new']:
    selected = [x for x in rows if x['version'] == version and x['stage'] in ['direct', 'old_replay']
                and x['sceneId'] in primary and x['success']]
    means[version] = {}
    for level in ['low', 'mid', 'high']:
        per_scene = [statistics.mean(x['nfcNonWhitespaceCodepoints'] for x in selected
                                    if x['sceneId'] == scene and x['level'] == level)
                     for scene in primary]
        result = statistics.mean(per_scene)
        expected = data['lengthSummary']['ordinary']['versions'][version]['sceneEqualMeans'][level]
        assert math.isclose(result, expected), (version, level)
        means[version][level] = result

review_summaries = []
review_indices = []
for reviewer in data['reviewerRows']:
    reviews = reviewer['rows']
    assert len(reviews) == 96
    assert len({(x['version'], x['sampleId']) for x in reviews}) == 96
    index = {(x['version'], x['sceneId'], x['level'], x['replicate']): x for x in reviews}
    assert len(index) == 96
    assert all(row['available'] and row['level'] in ['low', 'high'] for row in reviews)
    summary = {'reviewer': reviewer['reviewer'], 'primary': {}, 'allEndpointQuality': {}}
    for axis in ['warmth', 'engagement']:
        summary['primary'][axis] = {}
        for version in ['old', 'new']:
            delta = [index[(version, scene, 'high', n)][axis] - index[(version, scene, 'low', n)][axis]
                     for scene in primary for n in range(1, 4)]
            assert len(delta) == 12
            mean_delta = statistics.mean(delta)
            wins = sum(x > 0 for x in delta)
            summary['primary'][axis][version] = {
                'highMinusLow': mean_delta, 'wins': wins,
                'ties': sum(x == 0 for x in delta), 'losses': sum(x < 0 for x in delta),
                'n': 12, 'strictWinRate': wins / 12,
                'warmthScreenPassed': mean_delta >= .5 and wins / 12 >= .7 if axis == 'warmth' else None,
            }
            expected_reviewer = next(r for r in data['reviewerSummaries'] if r['reviewer'] == reviewer['reviewer'])
            expected = expected_reviewer['groups']['ordinary']['axes'][axis]['versions'][version]
            assert math.isclose(mean_delta, expected['highMinusLow'], abs_tol=.00005)
            assert wins == expected['highVsLow']['win']
    for version in ['old', 'new']:
        selected = [x for x in reviews if x['version'] == version]
        assert len(selected) == 48
        summary['allEndpointQuality'][version] = {
            'n': 48, 'unsupportedFact': sum(x['unsupportedFact'] for x in selected),
            'unsupportedHistoryOrRomance': sum(x['unsupportedHistoryOrRomance'] for x in selected),
            'boundaryRespected': sum(x['boundaryRespected'] for x in selected),
            'requestFollowed': sum(x['requestFollowed'] for x in selected),
            'personaConsistent': sum(x['personaConsistent'] for x in selected),
            'redundancyPositive': sum(x['redundancy'] > 0 for x in selected),
        }
    review_summaries.append(summary)
    review_indices.append(index)

for axis in ['warmth', 'engagement', 'redundancy']:
    distances = [abs(review_indices[0][key][axis] - review_indices[1][key][axis]) for key in review_indices[0]]
    expected = data['reviewerAgreement']['ordinal'][axis]
    assert expected['exact'] == sum(x == 0 for x in distances)
    assert expected['withinOne'] == sum(x <= 1 for x in distances)

assert data['executionStatus']['completed'] == 114
assert data['executionStatus']['physicalRequests'] == 115
assert data['executionStatus']['totalTokens'] == 1005358
print(json.dumps({'verified': True, 'sampleCounts': dict(Counter(x['version'] + '/' + x['stage'] for x in rows)),
                  'primarySceneEqualLengthMeans': means, 'reviewers': review_summaries,
                  'executionStatus': data['executionStatus']}, indent=2, ensure_ascii=True))
