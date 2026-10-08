"""Preview thread isolation, revision protocol, throttling and document safety."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from types import ModuleType, SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'addin/STEVE'))
from steve.render_feed import RenderFeed
from steve.render_preview import RenderPreview, mesh_snapshot

class PreviewTests(unittest.TestCase):
    def test_empty_fusion_bodies_do_not_block_visible_geometry(self):
        def collection(items):
            return SimpleNamespace(count=len(items), item=lambda i: items[i])
        empty = SimpleNamespace(isVisible=True, faces=collection([]))
        calculator = Mock()
        calculator.calculate.return_value = SimpleNamespace(triangleCount=1, nodeCount=3,
            nodeCoordinates=[SimpleNamespace(x=x, y=y, z=0) for x, y in [(0, 0), (1, 0), (0, 1)]],
            nodeIndices=[0, 1, 2])
        solid = SimpleNamespace(isVisible=True, faces=collection([object()]), entityToken='solid',
            revisionId='1', name='Plate', meshManager=SimpleNamespace(createMeshCalculator=lambda: calculator))
        proxy = SimpleNamespace(isVisible=True, nativeObject=empty)
        occurrence = SimpleNamespace(isVisible=True, bRepBodies=collection([proxy]),
            transform2=None, fullPathName='Empty key:1')
        root = SimpleNamespace(bRepBodies=collection([empty, solid]), allOccurrences=collection([occurrence]))
        adsk = ModuleType('adsk')
        adsk.fusion = ModuleType('adsk.fusion')
        adsk.fusion.Design = SimpleNamespace(cast=lambda _: SimpleNamespace(rootComponent=root))
        adsk.fusion.TriangleMeshQualityOptions = SimpleNamespace(LowQualityTriangleMesh=0)
        document = SimpleNamespace(isValid=True, name='Mount',
            products=SimpleNamespace(itemByProductType=lambda _: object()))
        with patch.dict(sys.modules, {'adsk': adsk, 'adsk.fusion': adsk.fusion}):
            packet = mesh_snapshot(document, {})
        self.assertEqual(len(packet['bodies']), 1)
        self.assertEqual(packet['bodies'][0]['name'], 'Plate')
        self.assertEqual(packet['bodies'][0]['positions'], [0, 0, 0, 10, 0, 0, 0, 10, 0])
        calculator.calculate.assert_called_once()

    def setUp(self):
        self.feed = RenderFeed()
        self.feed.accept('a', 'Build', 'project', 'owner')
        self.feed.observe({'bridgeRequestId':'a', 'threadId':'thread', 'provider':'chatgpt', 'busy':True})
        self.now = 0
        self.wake = Mock()
        self.export = Mock(return_value={'units':'mm','upAxis':'Z','bodies':[{'id':'body','positions':[0,0,0,10,0,0,0,10,0],'indices':[0,1,2]}]})
        self.preview = RenderPreview(self.feed, self.wake, self.export, lambda:self.now)
        self.document = object()
        self.state = {'threadId':'thread','provider':'chatgpt'}

    def test_request_only_queues_and_main_thread_exports_pinned_doc(self):
        self.assertTrue(self.preview.request('a',0)['pending'])
        self.export.assert_not_called()
        self.preview.run_main(self.state, self.document)
        self.export.assert_called_once_with(self.document, self.preview.cache)
        result = self.preview.request('a',0)
        self.assertEqual(result['revision'],1)
        self.assertEqual(result['units'],'mm')
        self.assertIn('bodies',result)
        self.assertNotIn('bodies', self.preview.request('a',1))
        self.assertTrue(self.preview.request('a',1)['unchanged'])
        reset = self.preview.request('a',100)
        self.assertTrue(reset['reset'])
        self.assertIn('bodies',reset)

    def test_throttled_revision_changes_only_when_geometry_changes(self):
        self.preview.request('a',0)
        self.preview.run_main(self.state,self.document)
        self.preview.request('a',0)
        self.now = 1
        self.preview.run_main(self.state,self.document)
        self.assertEqual(self.export.call_count,1)
        self.now = 2
        self.preview.run_main(self.state,self.document)
        self.assertEqual(self.preview.request('a',0)['revision'],1)
        self.export.return_value = {'units':'mm','upAxis':'Z','bodies':[]}
        self.now = 4
        self.preview.run_main(self.state,self.document)
        result = self.preview.request('a',1)
        self.assertEqual(result['revision'],2)
        self.assertEqual(result['bodies'],[])

    def test_other_chat_never_exports_current_document(self):
        self.preview.request('a',0)
        self.preview.run_main({'threadId':'other','provider':'chatgpt'},self.document)
        self.export.assert_not_called()
        self.assertIn('linked STEVE conversation',self.preview.request('a',0)['error'])
        with self.assertRaises(KeyError):self.preview.request('unknown',0)

    def test_export_failure_is_explicit_and_does_not_send_empty_mesh(self):
        self.export.side_effect = ValueError('Pinned document closed')
        self.preview.request('a',0)
        self.preview.run_main(self.state,self.document)
        result = self.preview.request('a',0)
        self.assertEqual(result['error'],'Pinned document closed')
        self.assertNotIn('bodies',result)

if __name__ == '__main__': unittest.main()
