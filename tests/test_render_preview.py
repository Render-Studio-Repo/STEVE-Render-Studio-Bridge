"""Preview thread isolation, revision protocol, throttling and document safety."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'addin/STEVE'))
from steve.render_feed import RenderFeed
from steve.render_preview import RenderPreview

class PreviewTests(unittest.TestCase):
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
