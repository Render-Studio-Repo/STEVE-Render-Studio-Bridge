"""Persistent project ownership and dispatch barriers, without Fusion."""
from pathlib import Path
import json
import sys
import tempfile
import threading
import queue
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'addin/STEVE'))
from steve.external_bridge import ExternalBridge, BridgeError, Submission
from steve.render_feed import RenderFeed
from steve.render_project import ProjectBinding, RenderProject


class ProjectTests(unittest.TestCase):
    def bind(self, bridge, user='alice', project='one', revision=None):
        return bridge.project_request(dict(action='bind', renderUserId=user,
            renderProjectId=project, expectedRevision=revision))['binding']

    def error(self, code, operation):
        with self.assertRaises(BridgeError) as raised:
            operation()
        self.assertEqual((raised.exception.status, raised.exception.code), (409, code))

    def test_cas_same_binding_and_aba_submission_revision(self):
        bridge = ExternalBridge(lambda: None)
        self.assertEqual(bridge.project_request({'action': 'get'}), {'version': 1, 'binding': None})
        self.error('project_unbound', lambda: bridge._enqueue(Submission('a', 'p', None, None, None), 'hash'))
        first = self.bind(bridge)
        self.assertEqual(len(first['revision']), 32)
        self.error('project_binding_changed', lambda: self.bind(bridge))
        self.assertEqual(self.bind(bridge, revision=first['revision']), first)
        second = self.bind(bridge, 'bob', 'two', first['revision'])
        third = self.bind(bridge, revision=second['revision'])
        self.assertNotEqual(first['revision'], third['revision'])
        old = Submission('a', 'p', None, None, None, 'one', 'alice', first['revision'])
        self.error('project_binding_changed', lambda: bridge._enqueue(old, 'hash'))
        for user, project in [('bob', 'one'), ('alice', 'two'), ('bob', 'two'), (None, None)]:
            self.error('project_mismatch', lambda: bridge._enqueue(
                Submission('a', 'p', None, None, None, project, user, third['revision']), 'hash'))
        self.assertEqual(bridge.drain_commands(), ())

    def test_queued_drained_running_saving_and_native_busy_barriers(self):
        bridge = ExternalBridge(lambda: None)
        first = self.bind(bridge)
        change = lambda: self.bind(bridge, project='two', revision=first['revision'])
        bridge._enqueue(Submission('a', 'p', None, None, None, 'one', 'alice', first['revision']), 'hash')
        self.error('project_busy', change)
        commands = bridge.drain_commands()
        self.assertEqual(len(commands), 1)
        self.error('project_busy', change)  # Queue empty; controller has not received Send.
        bridge.feed.observe({'bridgeRequestId': 'a', 'busy': True})
        self.error('project_busy', change)
        bridge.feed.save_status('a', {'state': 'pending'}, 'saving')
        self.error('project_busy', change)
        bridge.feed.save_status('a', {'state': 'done'}, 'completed')
        bridge._readiness = lambda: {'busy': True}
        self.error('project_busy', change)
        def readiness():
            self.assertTrue(bridge._lock.acquire(blocking=False), 'readiness called inside bridge lock')
            bridge._lock.release()
            return {'busy': False}
        bridge._readiness = readiness
        self.assertEqual(change()['renderProjectId'], 'two')
        self.assertEqual(bridge.feed.read('a', 0)['snapshot']['renderProjectId'], 'one')

    def test_persistence_rotation_origin_revocation_and_failed_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            bridge = ExternalBridge(lambda: None, config_path=config)
            first = self.bind(bridge)
            for _ in range(2):
                pair = bridge.request_pairing()
                bridge.approve_pairing(pair)
                bridge.complete_pairing(pair)
                self.assertEqual(bridge.project.binding.public(), first)
            path = config.with_name('render-project.json')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(ExternalBridge(lambda: None, config_path=config).project.binding.public(), first)
            with patch('steve.render_project.os.replace', side_effect=OSError('full')):
                with self.assertRaises(OSError):
                    self.bind(bridge, project='two', revision=first['revision'])
            self.assertEqual(bridge.project.binding.public(), first)
            self.assertEqual(json.loads(path.read_text())['binding'], first)
            with patch('steve.update_transaction.write_json', side_effect=OSError('full')):
                with self.assertRaises(OSError):
                    bridge.configure('https://other.example')
            self.assertEqual(bridge.project.binding.public(), first)
            self.assertEqual(ExternalBridge(lambda: None, config_path=config).project.binding.public(), first)
            bridge.configure('https://other.example')
            self.assertIsNone(bridge.project.binding)
            bridge.configure('https://render3d.app')
            self.assertIsNone(ExternalBridge(lambda: None, config_path=config).project.binding)

    def test_migration_only_missing_file_and_unique_owned_pair(self):
        for owners in [[('alice', 'one')], [('alice', 'one'), ('alice', 'one')],
                       [('alice', 'one'), ('alice', 'two')], [('alice', 'one'), ('bob', 'one')], []]:
            with self.subTest(owners=owners), tempfile.TemporaryDirectory() as folder:
                config = Path(folder) / 'render-bridge.json'
                feed = RenderFeed(config.with_name('render-chat-history.json'))
                feed.accept('legacy', 'Unowned')
                for index, (user, project) in enumerate(owners):
                    feed.accept(str(index), 'Owned', project, user)
                feed.flush()
                bridge = ExternalBridge(lambda: None, config_path=config)
                self.assertEqual(bridge.project.binding is not None, len(set(owners)) == 1)
                self.assertEqual(len(bridge.feed._requests), len(owners) + 1)
                bridge.project.replace(None)
                self.assertIsNone(ExternalBridge(lambda: None, config_path=config).project.binding)

    def test_corrupt_public_and_symlink_binding_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            path = config.with_name('render-project.json')
            feed = RenderFeed(config.with_name('render-chat-history.json'))
            feed.accept('a', 'Owned', 'one', 'alice')
            for raw, mode in [('broken', 0o600), ('[]', 0o600), ('{}', 0o600),
                              (json.dumps({'version': 1, 'renderOrigin': 'https://render3d.app',
                                           'binding': ProjectBinding.create('alice', 'one').public()}), 0o644)]:
                path.write_text(raw)
                path.chmod(mode)
                bridge = ExternalBridge(lambda: None, config_path=config)
                self.error('project_binding_changed', lambda: self.bind(bridge))
                self.assertTrue(bridge.project.error)
                self.assertEqual(path.read_text(), raw)
            path.unlink()
            path.symlink_to(Path(folder) / 'missing')
            self.assertTrue(ExternalBridge(lambda: None, config_path=config).project.error)

    def test_partial_or_malformed_owner_prevents_migration(self):
        for extra in [{'renderUserId': 'bob'}, {'renderProjectId': 'two'},
                      {'renderUserId': None, 'renderProjectId': 'two'},
                      {'renderUserId': 4, 'renderProjectId': 'two'}]:
            with self.subTest(extra=extra), tempfile.TemporaryDirectory() as folder:
                config = Path(folder) / 'render-bridge.json'
                feed = RenderFeed(config.with_name('render-chat-history.json'))
                feed.accept('valid', 'Owned', 'one', 'alice')
                feed.accept('partial', 'Uncertain')
                feed._requests['partial'].update(extra)
                feed.flush()
                bridge = ExternalBridge(lambda: None, config_path=config)
                self.assertIsNone(bridge.project.binding)
                self.assertFalse(bridge.project.error)

    def test_storage_retention_preserves_claimed_reservation_and_expires_completed_retry(self):
        from steve.render_storage import RenderStorage
        with tempfile.TemporaryDirectory() as folder:
            bridge = ExternalBridge(lambda: None)
            first = self.bind(bridge)
            storage = RenderStorage(None, bridge.feed, Path(folder) / 'storage.json', lambda: None)
            bridge.storage = storage
            storage.submit('retry', {'action': 'retrySave', 'requestId': 'original'})
            storage.queue.clear()  # Simulate run_main claiming work before handling it.
            bridge._save_retries['retry'] = 'original'
            bridge._pending_retries.add('retry')
            change = lambda: self.bind(bridge, project='two', revision=first['revision'])
            for i in range(140):
                key = str(i)
                storage.submit(key, {'action': 'getSettings'})
                storage.queue.clear()
                storage.operations[key]['pending'] = False
            self.assertTrue(storage.result('retry')['pending'])
            self.error('project_busy', change)
            storage.operations['retry']['pending'] = False
            storage.submit('last', {'action': 'getSettings'})
            storage.queue.clear()
            storage.operations['last']['pending'] = False
            with self.assertRaises(ValueError):
                storage.result('retry')
            change()
            self.assertNotIn('retry', bridge._pending_retries)
            self.assertNotIn('retry', bridge._save_retries)

    def test_controller_admission_serializes_native_start_with_bind_and_configure(self):
        from steve.controller import Controller
        for operation, native_action in [('bind', 'send'), ('bind', 'resume'), ('configure', 'send'), ('configure', 'resume')]:
            with self.subTest(operation=operation, native_action=native_action):
                controller = Controller.__new__(Controller)
                controller._lock = threading.RLock()
                controller.state = {'busy': False, 'jobBusy': False, 'codexRestarting': False,
                                    'serverSaving': False, 'job': {'status': 'paused'}, 'jobResumePending': False}
                controller._send_queued = False
                controller._closed = controller._update_handoff = False
                controller._job_control_revision = 0
                controller._commands = queue.Queue()
                bridge = ExternalBridge(lambda: None, readiness=controller.bridge_readiness,
                                        admission=controller.bridge_admission)
                first = self.bind(bridge)
                ready = threading.Event()
                attempted = threading.Event()
                started = threading.Event()
                def native_start():
                    if not ready.wait(2):
                        return
                    attempted.set()
                    if native_action == 'send':
                        controller.dispatch('send', {'text': 'Native direct send'})
                    else:
                        controller.dispatch('job', {'command': 'resume'})
                    started.set()
                worker = threading.Thread(target=native_start)
                worker.start()
                original = bridge._readiness
                def readiness():
                    value = original()
                    ready.set()
                    self.assertTrue(attempted.wait(2))
                    self.assertFalse(started.wait(0.05), 'native work started between readiness and commit')
                    self.assertTrue(bridge._lock.acquire(blocking=False))
                    bridge._lock.release()
                    return value
                bridge._readiness = readiness
                try:
                    if operation == 'bind':
                        self.bind(bridge, project='two', revision=first['revision'])
                    else:
                        bridge.configure('https://other.example')
                finally:
                    worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertTrue(started.is_set())
                self.assertTrue(controller._send_queued)
                self.assertEqual(controller._commands.qsize(), 1)
                bridge._readiness = original
                self.error('project_busy', lambda: self.bind(bridge, project='three',
                    revision=bridge.project.binding.revision if bridge.project.binding else None))

    def test_origin_commit_clears_connection_data_but_failed_and_same_origin_keep_it(self):
        from steve.render_storage import RenderStorage
        from steve.render_preview import RenderPreview
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            bridge = ExternalBridge(lambda: None, config_path=config)
            first = self.bind(bridge)
            bridge.feed.accept('old', 'Private old origin', 'one', 'alice')
            bridge.feed.fail('old', 'Done')
            bridge.storage = RenderStorage(None, bridge.feed, Path(folder) / 'storage.json', lambda: None)
            bridge.storage.operations['op'] = {'body': '{}', 'pending': False, 'result': {'private': 'old'}}
            document = object()
            bridge.storage.jobs['old'] = {'state': 'done', 'document': document}
            bridge.preview = RenderPreview(bridge.feed, lambda: None)
            bridge.preview.records['old'] = {'private': 'old mesh'}
            bridge.preview.queue['old'] = True
            bridge._save_retries['op'] = 'old'
            bridge._pending_retries.add('op')
            baseline = bridge.feed.activity('alice', 0)
            bridge.configure('https://render3d.app')
            self.assertEqual(bridge.feed.activity('alice', 0), baseline)
            second = self.bind(bridge, project='two', revision=first['revision'])
            self.assertEqual(bridge.feed.activity('alice', 0), baseline)
            self.assertIs(bridge.storage.jobs['old']['document'], document)
            with patch('steve.update_transaction.write_json', side_effect=OSError('full')):
                with self.assertRaises(OSError):
                    bridge.configure('https://other.example')
            self.assertEqual(bridge.feed.activity('alice', 0), baseline)
            self.assertEqual(bridge.project.binding.public(), second)
            self.assertIn('old', bridge.preview.records)
            self.assertIn('op', bridge.storage.operations)
            bridge.configure('https://other.example')
            self.assertEqual(bridge.feed.activity('alice', 0)['requests'], [])
            self.assertEqual(bridge.preview.records, {})
            self.assertEqual(bridge.preview.queue, {})
            self.assertEqual(bridge.storage.operations, {})
            self.assertEqual(bridge.storage.jobs, {})
            self.assertEqual(bridge._save_retries, {})
            self.assertEqual(bridge._pending_retries, set())
            self.bind(bridge)  # Identical IDs at a different origin must reveal nothing.
            with self.assertRaises(KeyError):
                bridge.feed.latest('one', 'alice')
            restored = ExternalBridge(lambda: None, config_path=config)
            self.assertEqual(restored.feed.activity('alice', 0)['requests'], [])

    def test_required_history_write_failure_preserves_origin_binding_and_legacy_history(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy), tempfile.TemporaryDirectory() as folder:
                config = Path(folder) / 'render-bridge.json'
                bridge = ExternalBridge(lambda: None, config_path=config)
                first = self.bind(bridge)
                bridge.feed.accept('old', 'Private transcript', 'one', 'alice')
                bridge.feed.fail('old', 'Done')
                if legacy:
                    saved = json.loads(bridge.feed.path.read_text())
                    saved.pop('renderOrigin')
                    bridge.feed.path.write_text(json.dumps(saved))
                baseline = bridge.feed.activity('alice', 0)
                old_bytes = bridge.feed.path.read_bytes()
                with patch('steve.render_feed.write_json', side_effect=OSError('history disk full')):
                    with self.assertRaises(OSError):
                        bridge.configure('https://other.example')
                self.assertEqual(bridge._render_origin, 'https://render3d.app')
                self.assertEqual(bridge.project.binding.public(), first)
                self.assertEqual(bridge.feed.activity('alice', 0), baseline)
                self.assertEqual(bridge.feed.path.read_bytes(), old_bytes)
                restored = ExternalBridge(lambda: None, config_path=config)
                self.assertEqual(restored._render_origin, 'https://render3d.app')
                self.assertEqual(restored.project.binding.public(), first)
                self.assertEqual(restored.feed.read('old', 0)['snapshot']['messages'][0]['text'], 'Private transcript')

    def test_failed_postcommit_clear_cannot_restore_old_origin_history(self):
        from steve.update_transaction import write_json
        for legacy in (False, True):
            with self.subTest(legacy=legacy), tempfile.TemporaryDirectory() as folder:
                config = Path(folder) / 'render-bridge.json'
                bridge = ExternalBridge(lambda: None, config_path=config)
                self.bind(bridge)
                bridge.feed.accept('old', 'Private old origin', 'one', 'alice')
                bridge.feed.fail('old', 'Done')
                if legacy:
                    saved = json.loads(bridge.feed.path.read_text())
                    saved.pop('renderOrigin')
                    bridge.feed.path.write_text(json.dumps(saved))
                def fail_new_origin_history(path, packet):
                    if packet.get('renderOrigin') == 'https://other.example':
                        raise OSError('postcommit history clear failed')
                    return write_json(path, packet)
                with patch('steve.render_feed.write_json', side_effect=fail_new_origin_history):
                    bridge.configure('https://other.example')
                    self.assertEqual(bridge.feed.activity('alice', 0)['requests'], [])
                    # Simulate abrupt restart without close()/flush() repairing the file.
                    retained = json.loads(bridge.feed.path.read_text())
                    self.assertEqual(retained['renderOrigin'], 'https://render3d.app')
                    self.assertEqual(retained['requests'][0]['requestId'], 'old')
                    restored = ExternalBridge(lambda: None, config_path=config)
                    self.assertEqual(restored._render_origin, 'https://other.example')
                    self.assertIsNone(restored.project.binding)
                    self.bind(restored)  # Same owner/project IDs at the new origin.
                    self.assertEqual(restored.feed.activity('alice', 0)['requests'], [])
                    with self.assertRaises(KeyError):
                        restored.feed.latest('one', 'alice')
                    # Returning to the old origin also requires durable cleanup;
                    # otherwise the old tagged file could be resurrected there.
                    with self.assertRaises(OSError):
                        restored.configure('https://render3d.app')
                    self.assertEqual(restored._render_origin, 'https://other.example')
                restored.configure('https://render3d.app')
                again = ExternalBridge(lambda: None, config_path=config)
                self.assertEqual(again.feed.activity('alice', 0)['requests'], [])

    def test_origin_change_waits_for_claimed_storage_operation(self):
        from steve.render_storage import RenderStorage
        with tempfile.TemporaryDirectory() as folder:
            bridge = ExternalBridge(lambda: None)
            self.bind(bridge)
            bridge.storage = RenderStorage(None, bridge.feed, Path(folder) / 'storage.json', lambda: None)
            bridge.storage.submit('op', {'action': 'getSettings'})
            bridge.storage.queue.clear()  # Claimed, still pending.
            with self.assertRaises(ValueError):
                bridge.configure('https://other.example')
            self.assertEqual(bridge._render_origin, 'https://render3d.app')
            self.assertIn('op', bridge.storage.operations)

    def test_origin_change_fences_inflight_preview_export(self):
        from steve.render_preview import RenderPreview
        bridge = ExternalBridge(lambda: None)
        self.bind(bridge)
        bridge.feed.accept('old', 'Private', 'one', 'alice')
        bridge.feed.fail('old', 'Done')
        exporting, release = threading.Event(), threading.Event()
        def exporter(document, cache):
            exporting.set()
            if not release.wait(2):
                raise RuntimeError('test timeout')
            cache['private'] = 'old'
            return {'bodies': ['old geometry']}
        preview = RenderPreview(bridge.feed, lambda: None, exporter=exporter)
        bridge.preview = preview
        preview.request('old', 0)
        worker = threading.Thread(target=preview.run_main, args=({'bridgeRequestId': 'old'}, object()))
        worker.start()
        try:
            self.assertTrue(exporting.wait(2))
            bridge.configure('https://other.example')
        finally:
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(preview.records, {})
        self.assertEqual(preview.cache, {})

    def test_retained_request_id_cannot_overwrite_dispatch_reservation(self):
        bridge = ExternalBridge(lambda: None)
        first = self.bind(bridge)
        submission = Submission('same', 'p', None, None, None, 'one', 'alice', first['revision'])
        bridge._enqueue(submission, 'hash')
        bridge.drain_commands()
        bridge.feed.fail('same', 'Done')
        bridge._requests.clear()  # Pairing rotation or idempotency cache expiry.
        self.error('request_id_conflict', lambda: bridge._enqueue(submission, 'hash'))
        self.assertEqual(bridge.feed.read('same', 0)['snapshot']['phase'], 'failed')

    def test_pairing_fence_rejects_authenticated_old_connection(self):
        bridge = ExternalBridge(lambda: None)
        bridge._secret = 'new-secret'
        handler = SimpleNamespace(_authenticated_secret='old-secret', headers={'Origin': 'https://render3d.app'})
        with self.assertRaises(BridgeError) as error:
            bridge.project_request({'action': 'bind', 'renderUserId': 'alice', 'renderProjectId': 'one',
                                    'expectedRevision': None}, handler)
        self.assertEqual(error.exception.code, 'pairing_changed')
        self.assertIsNone(bridge.project.binding)

    def test_restore_without_unix_getuid(self):
        import os
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'render-project.json'
            project = RenderProject(path, 'https://render3d.app', set())
            binding = ProjectBinding.create('alice', 'one')
            project.replace(binding)
            getuid = getattr(os, "getuid", None)
            try:
                if hasattr(os, "getuid"):
                    del os.getuid
                restored = RenderProject(path, 'https://render3d.app', set())
            finally:
                if getuid is not None:
                    os.getuid = getuid
            self.assertFalse(restored.error)
            self.assertEqual(restored.binding, binding)

    def test_pending_retry_barrier_survives_storage_queue_claim(self):
        bridge = ExternalBridge(lambda: None)
        first = self.bind(bridge)
        pending = [True]
        saving = [False]
        bridge.storage = SimpleNamespace(saving=lambda: saving[0], result=lambda _: {'pending': pending[0]})
        bridge._save_retries['retry'] = 'original'
        bridge._pending_retries.add('retry')
        change = lambda: self.bind(bridge, project='two', revision=first['revision'])
        self.error('project_busy', change)
        pending[0], saving[0] = False, True
        self.error('project_busy', change)
        saving[0] = False
        change()
        self.assertEqual(bridge._save_retries['retry'], 'original')


if __name__ == '__main__':
    unittest.main()
