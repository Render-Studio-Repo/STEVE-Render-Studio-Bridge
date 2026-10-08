"""Read-only, bounded live meshes. Native Fusion access is confined to run_main."""
from collections import OrderedDict
from copy import deepcopy
import hashlib
import json
import math
import threading
import time


def entries(collection):
    return [collection.item(i) for i in range(collection.count)]


def mesh_snapshot(document, cache):
    # Imported only on the Fusion main thread; unit tests inject an exporter.
    import adsk.fusion
    if not document or not document.isValid:
        raise ValueError('The pinned Fusion document is closed.')
    design = adsk.fusion.Design.cast(document.products.itemByProductType('DesignProductType'))
    if not design:
        raise ValueError('The pinned document is not a Fusion design.')
    root = design.rootComponent
    sources = [(body, None, 'root') for body in entries(root.bRepBodies) if body.isVisible]
    for occurrence in entries(root.allOccurrences):
        if occurrence.isVisible:
            for proxy in entries(occurrence.bRepBodies):
                if proxy.isVisible:
                    sources.append((proxy.nativeObject or proxy, occurrence.transform2, occurrence.fullPathName))
    if len(sources) > 256:
        raise ValueError('Live preview exceeds the 256-body limit; use the saved design import.')
    bodies, keep, triangles = [], {}, 0
    for body, transform, path in sources:
        key = (body.entityToken, body.revisionId, path,
               tuple(transform.asArray()) if transform else (), body.name)
        rendered = cache.get(key)
        if rendered is None:
            calculator = body.meshManager.createMeshCalculator()
            calculator.setQuality(adsk.fusion.TriangleMeshQualityOptions.LowQualityTriangleMesh)
            mesh = calculator.calculate()
            if not mesh:
                raise ValueError('Fusion could not tessellate a body; retaining the previous preview.')
            if mesh.triangleCount > 150000 or mesh.nodeCount > 450000:
                raise ValueError('Live preview mesh is too large; use the saved design import.')
            positions = []
            for point in mesh.nodeCoordinates:
                if transform:
                    point.transformBy(transform)
                positions.extend(round(value * 10, 5) for value in (point.x, point.y, point.z))
            if not all(math.isfinite(value) for value in positions):
                raise ValueError('Fusion returned invalid mesh coordinates.')
            indices = list(mesh.nodeIndices)
            rendered = {'id': hashlib.sha256((path + body.entityToken).encode()).hexdigest()[:24],
                        'name': body.name, 'positions': positions, 'indices': indices,
                        'color': [0.65, 0.7, 0.75]}
        triangles += len(rendered['indices']) // 3
        if triangles > 150000:
            raise ValueError('Live preview exceeds the 150,000-triangle limit; use the saved design import.')
        keep[key] = rendered
        bodies.append(rendered)
    result = {'units': 'mm', 'upAxis': 'Z', 'documentName': document.name, 'bodies': bodies}
    encoded = json.dumps(result, separators=(',', ':')).encode()
    if len(encoded) > 8_000_000:
        raise ValueError('Live preview exceeds 8 MB; use the saved design import.')
    cache.clear()
    cache.update(keep)
    return result


class RenderPreview:
    def __init__(self, feed, wake, exporter=mesh_snapshot, clock=time.monotonic):
        self.feed, self.wake, self.exporter, self.clock = feed, wake, exporter, clock
        self.lock = threading.Lock()
        self.records = OrderedDict()
        self.queue = OrderedDict()
        self.cache = {}
        self.cache_document = None
        self.last_export = -float('inf')
        self.revision = 0

    def request(self, request_id, after):
        self.feed.read(request_id, 0)  # Refuse arbitrary/unrelated IDs.
        with self.lock:
            if request_id not in self.queue:
                if len(self.queue) >= 8:
                    raise ValueError('Preview queue is full; retry later.')
                self.queue[request_id] = True
            value = self.records.get(request_id)
            if value:
                result = {k: deepcopy(v) for k, v in value.items() if k != '_digest'}
                if result['revision'] < after:
                    result['reset'] = True
                if result['revision'] == after:
                    result.pop('bodies', None)
                    result['unchanged'] = True
            else:
                result = {'requestId': request_id, 'revision': 0, 'pending': True}
        self.wake()
        return result

    def run_main(self, state, document):
        with self.lock:
            if not self.queue or self.clock() - self.last_export < 2:
                return
            pending = list(self.queue)
            self.queue.clear()
        self.last_export = self.clock()
        for request_id in pending:
            try:
                item = self.feed.read(request_id, 0)['snapshot']
            except KeyError:
                continue  # Pairing/address changes may clear the feed while a poll is queued.
            matches = (state.get('bridgeRequestId') == request_id or
                       bool(item.get('threadId') and item['threadId'] == state.get('threadId')
                            and item.get('provider') == state.get('provider')))
            try:
                if not matches or state.get('bridgeSendQueued'):
                    raise ValueError('Open the linked STEVE conversation to preview its pinned document.')
                if document is not self.cache_document:
                    self.cache.clear()
                    self.cache_document = document
                snapshot = self.exporter(document, self.cache)
                digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
                with self.lock:
                    old = self.records.get(request_id, {})
                    if old.get('_digest') != digest:
                        self.revision += 1
                        self.records[request_id] = {**snapshot, 'requestId': request_id,
                            'revision': self.revision, 'pending': False, '_digest': digest}
            except Exception as error:
                with self.lock:
                    self.revision += 1
                    self.records[request_id] = {'requestId': request_id, 'revision': self.revision,
                                               'pending': False, 'error': str(error)[:500]}
            with self.lock:
                while len(self.records) > 8:
                    self.records.popitem(last=False)
