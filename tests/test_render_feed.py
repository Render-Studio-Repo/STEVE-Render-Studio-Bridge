import sys
from pathlib import Path
import unittest
import tempfile
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'addin/STEVE'))
from steve.render_feed import RenderFeed

class RenderFeedTests(unittest.TestCase):
    def setUp(self):
        self.feed = RenderFeed()
        self.feed.accept('render-1', 'Make a bracket')
    def state(self, text='Hel', **changes):
        return {'bridgeRequestId':'render-1', 'busy':True, 'status':'Writing',
                'bridgeMessages':[{'role':'user','text':'INTERNAL WRAPPER'},
                                  {'id':'answer','role':'assistant','text':text},
                                  {'id':'secret','role':'reasoning','text':'PRIVATE'}], **changes}
    def test_stream_updates_and_completion(self):
        initial = self.feed.read('render-1',0)
        self.assertEqual(initial['snapshot']['phase'],'queued')
        self.feed.observe(self.state())
        first = self.feed.read('render-1',initial['cursor'])
        self.assertEqual(first['events'][-1]['message']['text'],'Hel')
        self.feed.observe(self.state('Hello',busy=False,status='Ready'))
        final = self.feed.read('render-1',first['cursor'])
        self.assertEqual(final['events'][-1]['message']['text'],'Hello')
        self.assertEqual(self.feed.read('render-1',0)['snapshot']['phase'],'completed')
        self.assertNotIn('PRIVATE',str(final))
        self.assertNotIn('INTERNAL WRAPPER',str(final))
    def test_scope_terminal_and_no_duplicate_updates(self):
        self.feed.observe(self.state())
        cursor=self.feed.read('render-1',0)['cursor']
        self.feed.observe(self.state())
        self.feed.observe(self.state('unrelated',bridgeRequestId=None))
        self.assertEqual(self.feed.read('render-1',cursor)['events'],[])
        self.feed.observe(self.state(busy=False,status='Stopped'))
        self.feed.observe(self.state('later local chat'))
        self.assertNotIn('later local chat',str(self.feed.read('render-1',0)))
    def test_gap_recovers_snapshot_and_credentials_redacted(self):
        for i in range(300): self.feed.observe(self.state(str(i)))
        result=self.feed.read('render-1',1)
        self.assertTrue(result['reset'])
        self.assertEqual(result['snapshot']['messages'][-1]['text'],'299')
        self.feed.observe(self.state('api_key=sk-exampletoken'))
        self.assertNotIn('sk-exampletoken',str(self.feed.read('render-1',0)))
        self.feed.clear()
        with self.assertRaises(KeyError): self.feed.read('render-1',0)
    def test_failure_and_request_isolation(self):
        self.feed.accept('render-2','Second prompt')
        self.feed.fail('render-1','The document is closed')
        self.assertEqual(self.feed.read('render-1',0)['snapshot']['phase'],'failed')
        self.assertNotIn('document is closed',str(self.feed.read('render-2',0)))

    def test_project_history_survives_restart_and_is_scoped_to_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'history.json'
            feed = RenderFeed(path)
            feed.accept('a', 'Build mount', 'project-a', 'alice')
            feed.observe({'bridgeRequestId': 'a', 'threadId': 'thread-a', 'provider': 'chatgpt',
                'busy': True, 'bridgeMessageStart': 0, 'bridgeMessages': [
                    {'role': 'user', 'text': 'INTERNAL'}, {'role': 'assistant', 'text': 'Working'}]})
            feed.flush()
            restored = RenderFeed(path)
            self.assertEqual(restored.latest('project-a', 'alice')['snapshot']['threadId'], 'thread-a')
            self.assertEqual(restored.latest('project-a', 'alice')['snapshot']['phase'], 'stopped')
            for project, user in [('project-a', 'bob'), ('project-b', 'alice')]:
                with self.assertRaises(KeyError): restored.latest(project, user)
            restored.observe({'threadId': 'thread-a', 'provider': 'chatgpt', 'busy': False,
                'messages': [{'role': 'user', 'text': 'INTERNAL'},
                    {'role': 'assistant', 'text': 'Restored reply'},
                    {'role': 'user', 'text': 'Continue this mount'}]})
            snapshot = restored.latest('project-a', 'alice')['snapshot']
            self.assertEqual(snapshot['messages'][-1]['text'], 'Continue this mount')
            self.assertNotIn('INTERNAL', str(snapshot))
            restored.observe({'threadId': 'unrelated', 'provider': 'chatgpt', 'messages': [
                {'role': 'assistant', 'text': 'OTHER PRIVATE CHAT'}]})
            self.assertNotIn('OTHER PRIVATE CHAT', str(restored.latest('project-a', 'alice')))
            restored.clear()
            with self.assertRaises(KeyError): RenderFeed(path).latest('project-a', 'alice')

if __name__=='__main__': unittest.main()
