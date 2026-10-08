import sys
from pathlib import Path
import unittest
import tempfile
import json
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'addin/STEVE'))
from steve.render_feed import RenderFeed

class RenderFeedTests(unittest.TestCase):
    def test_failed_undispatched_reply_cannot_inherit_native_answer(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'history.json'
            feed = RenderFeed(path)
            feed.accept('original', 'Original prompt', 'one', 'alice')
            feed.observe({'bridgeRequestId': 'original', 'threadId': 'linked', 'provider': 'chatgpt',
                          'bridgeMessages': [{'role': 'user', 'text': 'wrapper'},
                                             {'id': 'answer', 'role': 'assistant', 'text': 'Old answer'}]})
            feed.accept('reply', 'Follow up', 'one', 'alice', reply_to_request_id='original',
                        reply_target=('chatgpt', 'linked'))
            feed.fail('reply', 'target_document_mismatch')
            failed = feed.read('reply', 0)['snapshot']
            publication = {'threadId': 'linked', 'provider': 'chatgpt', 'status': 'Ready',
                           'messages': [{'role': 'user', 'text': 'wrapper'},
                                        {'id': 'answer', 'role': 'assistant', 'text': 'Old answer'}]}
            for current in (feed, RenderFeed(path)):
                current.observe(publication)
                self.assertEqual(current.read('reply', 0)['snapshot'], failed)
            # Only a publication carrying this request's actual send messages
            # unlocks native continuation mirroring for the targeted reply.
            feed.accept('sent', 'Delivered reply', 'one', 'alice', reply_to_request_id='original',
                        reply_target=('chatgpt', 'linked'))
            feed.observe({'bridgeRequestId': 'sent', 'threadId': 'linked', 'provider': 'chatgpt',
                          'busy': True, 'bridgeMessages': [{'role': 'user', 'text': 'reply wrapper'}]})
            self.assertTrue(feed.read('sent', 0)['snapshot']['replyDispatched'])
            feed.observe(publication)
            self.assertEqual(feed.read('sent', 0)['snapshot']['phase'], 'completed')

    def test_cross_owner_count_eviction_changes_epoch(self):
        feed = RenderFeed()
        feed.accept('alice-old', 'old', 'one', 'alice')
        feed.accept('alice-kept', 'kept', 'two', 'alice')
        for i in range(62):
            feed.accept(str(i), 'bob', 'one', 'bob')
        baseline = feed.activity('alice', 0)
        feed.accept('bob-new', 'new', 'two', 'bob')
        delta = feed.activity('alice', baseline['cursor'])
        self.assertEqual(delta['requests'], [])
        self.assertNotEqual(delta['epoch'], baseline['epoch'])
        refreshed = feed.activity('alice', 0)
        self.assertTrue(refreshed['reset'])
        self.assertEqual([r['requestId'] for r in refreshed['requests']], ['alice-kept'])
        self.assertEqual(refreshed['epoch'], delta['epoch'])

    def test_cross_owner_byte_eviction_changes_epoch(self):
        feed = RenderFeed()
        feed.accept('alice-old', 'a' * 1000, 'one', 'alice')
        feed.accept('alice-kept', 'kept', 'two', 'alice')
        baseline = feed.activity('alice', 0)
        with patch('steve.render_feed.MAX_HISTORY_BYTES', 1800):
            feed.accept('bob-new', 'b' * 1000, 'two', 'bob')
        delta = feed.activity('alice', baseline['cursor'])
        self.assertEqual(delta['requests'], [])
        self.assertNotEqual(delta['epoch'], baseline['epoch'])
        refreshed = feed.activity('alice', 0)
        self.assertTrue(refreshed['reset'])
        self.assertEqual([r['requestId'] for r in refreshed['requests']], ['alice-kept'])
        self.assertEqual(refreshed['epoch'], delta['epoch'])

    def test_activity_is_owner_scoped_across_projects_and_incremental(self):
        feed = RenderFeed()
        for key, project, owner in [('a', 'one', 'alice'), ('b', 'two', 'alice'),
                                     ('c', 'one', 'bob'), ('d', 'two', 'bob')]:
            feed.accept(key, key, project, owner)
        feed.accept('local', 'Unlinked private chat')
        baseline = feed.activity('alice', 0)
        self.assertTrue(baseline['reset'])
        self.assertEqual([r['requestId'] for r in baseline['requests']], ['a', 'b'])
        self.assertEqual(feed.activity('alice', baseline['cursor'])['requests'], [])
        feed.fail('c', 'Bob only')
        self.assertEqual(feed.activity('alice', baseline['cursor'])['requests'], [])
        feed.observe({'bridgeRequestId': 'b', 'busy': True, 'bridgeMessages': [
            {'role': 'user', 'text': 'INTERNAL'},
            {'id': 'reply', 'role': 'assistant', 'text': 'Hello api_key=sk-secret'},
            {'role': 'reasoning', 'text': 'PRIVATE THOUGHT'},
            {'role': 'tool', 'text': 'Public result', 'arguments': 'SECRET ARGS'}]})
        streaming = json.dumps(feed.activity('alice', baseline['cursor']))
        for private in ['PRIVATE THOUGHT', 'SECRET ARGS', 'sk-secret', 'INTERNAL']:
            self.assertNotIn(private, streaming)
        feed.observe({'bridgeRequestId': 'b', 'busy': False, 'bridgeMessages': [
            {'role': 'user', 'text': 'INTERNAL'},
            {'id': 'reply', 'role': 'assistant', 'text': 'Finished'}]})
        delta = feed.activity('alice', baseline['cursor'])
        self.assertFalse(delta['reset'])
        self.assertEqual(len(delta['requests']), 1)
        self.assertEqual(delta['requests'][0], feed.read('b', 0)['snapshot'])
        self.assertEqual(delta['requests'][0]['phase'], 'completed')
        self.assertEqual(feed.activity('alice', delta['cursor'])['requests'], [])
        for private in ['Bob only', 'Unlinked private chat', 'PRIVATE THOUGHT', 'SECRET ARGS', 'sk-secret', 'INTERNAL']:
            self.assertNotIn(private, json.dumps(delta))
        delta['requests'][0]['messages'].clear()
        self.assertTrue(feed.read('b', 0)['snapshot']['messages'])

    def test_activity_rollover_retention_clear_and_restart_epoch(self):
        with tempfile.TemporaryDirectory() as folder:
            feed = RenderFeed(Path(folder) / 'history.json')
            feed.accept('a', 'a', 'one', 'alice')
            original = feed.activity('alice', 0)
            for i in range(70):
                feed.accept(str(i), 'prompt', str(i % 2), 'alice')
            for i in range(300):
                feed.fail('69', str(i))
            baseline = feed.activity('alice', original['cursor'])
            self.assertTrue(baseline['reset'])
            self.assertEqual(len(baseline['requests']), 64)
            self.assertEqual(baseline['requests'][0]['requestId'], '6')
            restored = RenderFeed(feed.path)
            self.assertTrue(restored.activity('alice', baseline['cursor'])['reset'])
            self.assertNotEqual(restored.activity('alice', 0)['epoch'], baseline['epoch'])
            # New events can overtake the old cursor: epoch still detects restart.
            restored.accept('new', 'new', 'two', 'alice')
            self.assertNotEqual(restored.activity('alice', 1)['epoch'], original['epoch'])
            empty_epoch = RenderFeed().activity('alice', 0)
            self.assertTrue(empty_epoch['reset'])
            self.assertEqual(empty_epoch['cursor'], 0)
            restored.clear()
            cleared = restored.activity('alice', 0)
            self.assertEqual(cleared['requests'], [])
            self.assertNotEqual(cleared['epoch'], baseline['epoch'])

    def test_activity_reports_transcript_removal_without_new_messages(self):
        self.feed.accept('owned', 'prompt', 'one', 'alice')
        state = {'bridgeRequestId': 'owned', 'busy': True, 'bridgeMessages': [
            {'role': 'user', 'text': 'INTERNAL'}, {'id': 'reply', 'role': 'assistant', 'text': 'hi'}]}
        self.feed.observe(state)
        cursor = self.feed.activity('alice', 0)['cursor']
        state['bridgeMessages'] = state['bridgeMessages'][:1]
        self.feed.observe(state)
        delta = self.feed.activity('alice', cursor)
        self.assertEqual(len(delta['requests']), 1)
        self.assertEqual(len(delta['requests'][0]['messages']), 1)

    def test_activity_serialized_bound_preserves_full_feed_snapshots(self):
        feed = RenderFeed()
        for i in range(64):
            feed.accept(str(i), 'prompt', 'project', 'alice')
        for i in range(4):
            state = {'bridgeRequestId': str(i), 'busy': True, 'bridgeMessages': [
                {'role': 'user', 'text': 'INTERNAL'}] + [
                {'id': str(j), 'role': 'assistant', 'text': '\U0001f600' * 32000} for j in range(25)]}
            feed.observe(state)
            cursor = feed.activity('alice', 0)['cursor']
            feed.observe(state)
            self.assertEqual(feed.activity('alice', cursor)['requests'], [])
        result = feed.activity('alice', 0)
        self.assertEqual(len(result['requests']), 64)
        self.assertLess(len(json.dumps(result).encode()), 8_000_000)
        self.assertTrue(any(item.get('transcriptTruncated') for item in result['requests']))
        for item in result['requests']:
            self.assertEqual(item, feed.read(item['requestId'], 0)['snapshot'])
        self.assertEqual(feed.activity('alice', result['cursor'])['requests'], [])

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
