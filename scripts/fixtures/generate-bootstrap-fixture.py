"""Extract verbatim Python response dictionaries; preserve nulls and camelCase.

Usage: python scripts/fixtures/generate-bootstrap-fixture.py SERVER_TESTS SERVER_MODULE
SERVER_TESTS is the hosting service's test file and SERVER_MODULE the module
that implements the bootstrap service; both live in the server's repository.
The server's tests assert complete starting dicts, but only individual ready
fields. Ready therefore comes from the actual decorated method's return dict.
Only dynamic identity/token expressions are replaced with local test values.
"""
import ast
import json
import sys
from pathlib import Path

tests, server = (Path(arg).resolve() for arg in sys.argv[1:3])
preview = 'pod.preview.apps.abacus.ai'
host_base = '/api/botHost/1c0d9e2f7a'
token = 'eyJvIjoib3duZXIiLCJnIjoib3JnIiwiZSI6OTk5OTk5OTk5OX0.signature'
fixtures = []
for path in (tests, server):
    source = path.read_text()
    tree = ast.parse(source)
    for node in ast.walk(tree):
        candidate = None
        if path == tests and isinstance(node, ast.Assert) and isinstance(node.test, ast.Compare):
            candidate = node.test.comparators[0]
        if path == server and isinstance(node, ast.Return):
            candidate = node.value
        if not isinstance(candidate, ast.Dict):
            continue
        pairs = dict(zip([k.value if isinstance(k, ast.Constant) else None for k in candidate.keys], candidate.values))
        status = pairs.get('status')
        if not isinstance(status, ast.Constant) or status.value not in ('starting', 'ready'):
            continue
        if path == server and status.value != 'ready':
            continue
        result = {}
        for key, value in pairs.items():
            if isinstance(value, ast.Constant):
                result[key] = value.value
            elif key in ('previewHost', 'preview_host'):
                result[key] = preview
            elif key in ('hostBase', 'host_base'):
                result[key] = host_base
            elif key == 'token':
                result[key] = token
            elif key == 'version':
                result[key] = '1.2-web.3'  # MANIFEST in the Python tests
            else:
                raise ValueError((key, ast.dump(value)))
        result = {''.join([k.split('_')[0]] + [part.title() for part in k.split('_')[1:]]): v for k, v in result.items()}
        fixtures.append({'source': 'server response fixture (kept in step with the hosting service)', 'python': ast.get_source_segment(source, candidate), 'result': result})
output = Path(__file__).resolve().parents[2] / 'apps/web/src/features/shell/connect/fixtures/bootstrap-server.json'
output.write_text(json.dumps(fixtures, indent=2) + '\n')
