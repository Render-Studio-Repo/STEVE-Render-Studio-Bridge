"""Exercise the external bridge through its loopback HTTP boundary."""
from hashlib import sha256
import hmac
import http.client
import json
from pathlib import Path
import sys
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4
from types import SimpleNamespace as Obj
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "addin/STEVE"))
from steve.external_bridge import ExternalBridge, BridgeError, MAX_QUEUE_SIZE, Submission, submission_message


ORIGIN = "http://render-studio.test"


class BridgeHTTPTests(unittest.TestCase):
    def test_signed_reply_contract_and_busy_queue(self):
        secret = self.pair()
        self.assertTrue(self.request('/v1/status')[2]['capabilities']['replyToRequest'])
        body = {'prompt': 'Follow up', 'replyToRequestId': 'original'}
        status, _, packet = self.submit(secret, body)
        self.assertEqual((status, packet['error']['code']), (404, 'request_not_found'))
        self.bridge.feed.accept('original', 'Other project', 'other', 'alice')
        status, _, packet = self.submit(secret, body)
        self.assertEqual((status, packet['error']['code']), (409, 'project_mismatch'))
        self.bridge.feed.accept('original', 'Owned', 'render-a', 'alice')
        self.bridge.feed.observe({'bridgeRequestId': 'original', 'threadId': 'linked',
                                  'provider': 'chatgpt', 'busy': True})
        self.bridge._readiness = lambda: {'providerReady': True, 'busy': True}
        self.assertEqual(self.submit(secret, body)[0], 202)
        self.assertEqual(self.submit(secret, body)[0], 200)
        self.assertEqual(self.submit(secret, {**body, 'replyToRequestId': 'different'})[0], 409)
        commands = self.bridge.drain_commands()
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0].reply_target, ('chatgpt', 'linked'))

    def test_activity_contract_auth_validation_cors_and_no_model_work(self):
        payload = {'renderUserId': 'alice', 'after': 0}
        self.assertEqual(self.request('/v1/activity', 'POST', payload)[0], 401)
        secret = self.pair()
        self.bridge.project_request({'action': 'bind', 'renderUserId': 'alice', 'renderProjectId': 'one', 'expectedRevision': self.bridge.project.binding.revision})
        for key, project, owner in [('a', 'one', 'alice'), ('b', 'two', 'alice'),
                                     ('c', 'one', 'bob'), ('d', 'two', 'bob')]:
            self.bridge.feed.accept(key, key, project, owner)
        wakes = self.wakes
        def activity(body, key=secret, extra=None):
            return self.request('/v1/activity', 'POST', body,
                {**self.auth(key, body, path='/v1/activity'), **(extra or {})})
        status, headers, result = activity(payload)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(headers['Access-Control-Allow-Origin'], ORIGIN)
        self.assertEqual(set(result), {'version', 'cursor', 'epoch', 'reset', 'requests', 'binding', 'busy', 'availableForProjectChange'})
        self.assertEqual([item['requestId'] for item in result['requests']], ['a'])
        payload['after'] = result['cursor']
        self.assertEqual(activity(payload)[2]['requests'], [])
        self.bridge.feed.fail('a', 'Failed')
        self.assertEqual([r['requestId'] for r in activity(payload)[2]['requests']], ['a'])
        self.assertEqual(activity({'renderUserId': 'nobody', 'after': 0})[2]['requests'], [])
        for bad in [{}, {'renderUserId': 'alice'}, {'after': 0},
                    *[{'renderUserId': value, 'after': 0} for value in ['', ' ', None, 1, 'x' * 257]],
                    *[{'renderUserId': 'alice', 'after': value} for value in [True, -1, 1.5, '1', None]],
                    {**payload, 'renderProjectId': 'one'}, {**payload, 'knownEpoch': 'x'}]:
            with self.subTest(bad=bad):
                self.assertEqual(activity(bad)[0], 400)
        self.assertEqual(activity(payload, key='wrong')[0], 401)
        self.assertEqual(activity(payload, extra={'Origin': 'https://evil.example'})[0], 403)
        status, headers, _ = self.request('/v1/activity', 'OPTIONS', headers={
            'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Private-Network'], 'true')
        self.assertIn('X-Steve-Signature', headers['Access-Control-Allow-Headers'])
        self.assertEqual(self.bridge.drain_commands(), ())
        self.assertEqual(self.wakes, wakes)

    def setUp(self):
        self.wakes = 0
        self.bridge = ExternalBridge(
            lambda: setattr(self, "wakes", self.wakes + 1),
            readiness=lambda: {"fusionRunning": True, "providerReady": True, "busy": False},
            origins={ORIGIN},
            port=0,
        )
        self.bridge.start()
        self.base = f"http://127.0.0.1:{self.bridge.port}"

    def tearDown(self):
        self.bridge.close()

    def request(self, path, method="GET", payload=None, headers=None):
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        request = Request(self.base + path, data=body, method=method,
                          headers={"Origin": ORIGIN, **({"Content-Type": "application/json"} if body is not None else {}),
                                   **(headers or {})})
        try:
            response = urlopen(request, timeout=3)
            data = response.read()
            return response.status, response.headers, json.loads(data) if data else None
        except HTTPError as error:
            data = error.read()
            return error.code, error.headers, json.loads(data) if data else None

    def pair(self):
        status, _, result = self.request("/v1/pairing/request", "POST", {})
        self.assertEqual(status, 202)
        pairing_id = result["pairingId"]
        self.bridge.approve_pairing(pairing_id)
        status, _, result = self.request("/v1/pairing/complete", "POST", {"pairingId": pairing_id})
        self.assertEqual(status, 200)
        self.bridge.project_request({'action': 'bind', 'renderUserId': 'alice', 'renderProjectId': 'render-a', 'expectedRevision': None})
        return result["secret"]

    def auth(self, secret, body, request_id="request-1", nonce=None, timestamp=None, path="/v1/submissions"):
        nonce = nonce or uuid4().hex
        timestamp = str(timestamp or int(time.time()))
        body_bytes = json.dumps(body, separators=(",", ":")).encode()
        digest = sha256(body_bytes).hexdigest()
        signed = f"POST\n{path}\n{timestamp}\n{nonce}\n{request_id}\n{digest}".encode()
        return {
            "X-Request-Id": request_id,
            "X-Steve-Timestamp": timestamp,
            "X-Steve-Nonce": nonce,
            "X-Steve-Signature": hmac.new(secret.encode(), signed, sha256).hexdigest(),
        }

    def submit(self, secret, body, request_id="request-1", nonce=None, timestamp=None):
        body = {"bindingRevision": self.bridge.project.binding.revision, **body}
        if "renderUserId" not in body and "renderProjectId" not in body:
            body.update(renderUserId="alice", renderProjectId="render-a")
        return self.request("/v1/submissions", "POST", body,
                            self.auth(secret, body, request_id, nonce, timestamp))

    def test_authenticated_project_lookup_preserves_render_scope(self):
        secret = self.pair()
        body = {'prompt': 'Create a mount', 'renderProjectId': 'render-a', 'renderUserId': 'alice'}
        status, _, _ = self.submit(secret, body)
        self.assertEqual(status, 202)
        payload = {'renderProjectId': 'render-a', 'renderUserId': 'alice', 'after': 0}
        status, _, result = self.request('/v1/events', 'POST', payload,
            self.auth(secret, payload, path='/v1/events'))
        self.assertEqual(status, 200)
        self.assertEqual(result['snapshot']['requestId'], 'request-1')
        payload['renderUserId'] = 'bob'
        status, _, _ = self.request('/v1/events', 'POST', payload,
            self.auth(secret, payload, path='/v1/events'))
        self.assertEqual(status, 409)
        status, _, _ = self.submit(secret, {'prompt': 'x', 'renderProjectId': 'render-a'}, request_id='partial')
        self.assertEqual(status, 400)

    def test_preview_requires_signed_request_and_known_id(self):
        from steve.render_preview import RenderPreview
        secret = self.pair()
        self.bridge.preview = RenderPreview(self.bridge.feed, lambda: None)
        self.bridge.feed.accept('mesh-a', 'Build', 'render-a', 'alice')
        payload = {'requestId': 'mesh-a', 'afterRevision': 0}
        self.assertEqual(self.request('/v1/preview', 'POST', payload)[0], 401)
        status, _, result = self.request('/v1/preview', 'POST', payload,
            self.auth(secret, payload, path='/v1/preview'))
        self.assertEqual(status, 202)
        self.assertTrue(result['pending'])
        payload['requestId'] = 'unrelated'
        self.assertEqual(self.request('/v1/preview', 'POST', payload,
            self.auth(secret, payload, path='/v1/preview'))[0], 404)
        payload['afterRevision'] = True
        self.assertEqual(self.request('/v1/preview', 'POST', payload,
            self.auth(secret, payload, path='/v1/preview'))[0], 400)

    def test_status_is_sanitized_and_reports_capabilities(self):
        status, headers, result = self.request("/v1/status")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(result, {
            "version": 1,
            "phase": "unpaired",
            "connected": False,
            "fusionRunning": True,
            "providerReady": True,
            "busy": False,
            "ready": False,
            "pairingId": None,
            "capabilities": {"authPing": True, "submitPrompt": True, "replyToRequest": True, "destinationMetadata": True, "createFolder": False, "chatEvents": True, "projectChatHistory": True, "activityFeed": True, "projectBinding": True, "livePreview": False, "storageSettings": False, "autoSave": False, "autoReadOnly": False},
            "queueDepth": 0,
        })
        self.assertNotIn("secret", json.dumps(result).lower())

    def test_ping_requires_authentication_and_does_not_queue_work(self):
        self.assertEqual(self.request('/v1/ping', 'POST', {})[0], 401)
        secret = self.pair()
        status, _, result = self.request('/v1/ping', 'POST', {}, self.auth(secret, {}, path='/v1/ping'))
        self.assertEqual(status, 200)
        self.assertTrue(result['authenticated'])
        self.assertEqual(self.bridge.status()['queueDepth'], 0)
        self.assertEqual(self.request('/v1/ping', 'POST', {}, self.auth('wrong', {}, path='/v1/ping'))[0], 401)

    def test_restored_key_rejects_requests_signed_before_restart(self):
        secret = self.pair()
        now = int(time.time())
        self.bridge._clock = lambda: now + 2
        self.bridge._auth_not_before = now + 1
        body = {"prompt": "Create a bracket"}
        status, _, result = self.submit(secret, body, timestamp=now)
        self.assertEqual((status, result['error']['code']), (401, 'expired'))
        self.assertEqual(self.submit(secret, body, timestamp=now + 2)[0], 202)

    def test_pairing_requires_explicit_approval_and_secret_is_returned_once(self):
        _, _, requested = self.request("/v1/pairing/request", "POST", {})
        pairing_id = requested["pairingId"]
        status, _, pending = self.request("/v1/pairing/complete", "POST", {"pairingId": pairing_id})
        self.assertEqual((status, pending["error"]["code"]), (409, "pairing_pending"))
        self.bridge.approve_pairing(pairing_id)
        status, _, completed = self.request("/v1/pairing/complete", "POST", {"pairingId": pairing_id})
        self.assertEqual(status, 200)
        self.assertGreater(len(completed["secret"]), 32)
        status, _, repeated = self.request("/v1/pairing/complete", "POST", {"pairingId": pairing_id})
        self.assertEqual((status, repeated["error"]["code"]), (404, "pairing_not_found"))

    def test_pairing_can_be_denied(self):
        _, _, requested = self.request("/v1/pairing/request", "POST", {})
        self.bridge.deny_pairing(requested["pairingId"])
        status, _, result = self.request("/v1/pairing/complete", "POST", {"pairingId": requested["pairingId"]})
        self.assertEqual((status, result["error"]["code"]), (403, "pairing_denied"))

    def test_submission_is_authenticated_and_preserves_destination_metadata(self):
        secret = self.pair()
        body = {"prompt": "Create a 20 mm bracket", "projectId": "project-a",
                "folderId": "folder-b", "designName": "bracket"}
        status, _, result = self.submit(secret, body)
        self.assertEqual((status, result), (202, {"version": 1, "requestId": "request-1", "accepted": True}))
        commands = self.bridge.drain_commands()
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0].submission.prompt, "Create a 20 mm bracket")
        self.assertEqual(commands[0].submission.folder_id, "folder-b")
        self.assertEqual(self.wakes, 3)

    def test_bad_signature_expired_timestamp_and_nonce_replay_are_rejected(self):
        secret = self.pair()
        body = {"prompt": "Create a plate"}
        headers = self.auth(secret, body)
        headers["X-Steve-Signature"] = "0" * 64
        status, _, result = self.request("/v1/submissions", "POST", body, headers)
        self.assertEqual((status, result["error"]["code"]), (401, "invalid_signature"))
        status, _, result = self.submit(secret, body, timestamp=int(time.time()) - 120)
        self.assertEqual((status, result["error"]["code"]), (401, "expired"))
        nonce = uuid4().hex
        self.assertEqual(self.submit(secret, body, nonce=nonce)[0], 202)
        status, _, result = self.submit(secret, body, request_id="request-2", nonce=nonce)
        self.assertEqual((status, result["error"]["code"]), (409, "replay"))

    def test_request_id_is_idempotent_but_cannot_change_content(self):
        secret = self.pair()
        first = {"prompt": "Create a plate"}
        self.assertEqual(self.submit(secret, first)[0], 202)
        status, _, result = self.submit(secret, first)
        self.assertEqual((status, result["accepted"]), (200, False))
        status, _, result = self.submit(secret, {"prompt": "Create a cube"})
        self.assertEqual((status, result["error"]["code"]), (409, "request_id_conflict"))
        self.assertEqual(len(self.bridge.drain_commands()), 1)

    def test_queue_and_input_bounds_are_enforced(self):
        secret = self.pair()
        for index in range(MAX_QUEUE_SIZE):
            status, _, _ = self.submit(secret, {"prompt": f"Part {index}"}, request_id=f"request-{index}")
            self.assertEqual(status, 202)
        status, _, result = self.submit(secret, {"prompt": "One too many"}, request_id="overflow")
        self.assertEqual((status, result["error"]["code"]), (429, "queue_full"))
        self.bridge.drain_commands()
        status, _, result = self.submit(secret, {"prompt": "x" * 32001}, request_id="long")
        self.assertEqual((status, result["error"]["code"]), (400, "invalid_request"))

    def test_ready_requires_pairing_and_provider_readiness(self):
        self.assertFalse(self.request("/v1/status")[2]["ready"])
        self.pair()
        status = self.request("/v1/status")[2]
        self.assertTrue(status["connected"])
        self.assertTrue(status["providerReady"])
        self.assertTrue(status["ready"])

    def test_origin_host_and_preflight_are_strict(self):
        request = Request(self.base + "/v1/status", headers={"Origin": "https://evil.example"})
        with self.assertRaises(HTTPError) as raised:
            urlopen(request, timeout=3)
        self.assertEqual(raised.exception.code, 403)
        self.assertIsNone(raised.exception.headers.get("Access-Control-Allow-Origin"))

        connection = http.client.HTTPConnection("127.0.0.1", self.bridge.port, timeout=3)
        connection.putrequest("GET", "/v1/status", skip_host=True)
        connection.putheader("Host", "evil.example")
        connection.putheader("Origin", ORIGIN)
        connection.endheaders()
        self.assertEqual(connection.getresponse().status, 403)
        connection.close()

        status, headers, _ = self.request("/v1/submissions", "OPTIONS")
        self.assertEqual(status, 204)
        self.assertIn("X-Steve-Signature", headers["Access-Control-Allow-Headers"])

    def test_chat_feed_requires_signature_and_scopes_results(self):
        secret = self.pair()
        self.submit(secret, {"prompt": "Create a bracket"})
        payload = {"requestId": "request-1", "after": 0}
        self.assertEqual(self.request("/v1/events", "POST", payload)[0], 401)
        def event_request(payload, secret=secret):
            body = json.dumps(payload, separators=(",", ":")).encode()
            timestamp, nonce, request_id = str(int(time.time())), uuid4().hex, uuid4().hex
            signed = f"POST\n/v1/events\n{timestamp}\n{nonce}\n{request_id}\n{sha256(body).hexdigest()}".encode()
            headers = {"X-Steve-Timestamp":timestamp, "X-Steve-Nonce":nonce, "X-Request-Id":request_id,
                       "X-Steve-Signature":hmac.new(secret.encode(),signed,sha256).hexdigest()}
            return self.request("/v1/events", "POST", payload, headers)
        status, _, result = event_request(payload)
        self.assertEqual(status, 200)
        self.assertEqual(result['snapshot']['messages'][0]['text'], 'Create a bracket')
        self.assertNotIn(secret, str(result))
        self.assertEqual(event_request({"requestId":"other", "after":0})[0], 404)
        self.assertEqual(event_request({"requestId":"request-1", "after":True})[0], 400)
        self.assertEqual(self.request('/v1/events', 'OPTIONS')[0], 204)
        self.bridge.drain_commands()
        self.bridge.feed.fail('request-1', 'Stopped')
        self.bridge.configure('http://localhost:5173')
        self.assertEqual(event_request(payload)[0], 403)

    def test_storage_is_authenticated_and_queued(self):
        secret = self.pair()
        self.bridge.storage = Obj(submit=Mock(return_value={"requestId":"storage-1", "pending":True}),
                                  result=Mock(return_value={"requestId":"storage-1", "pending":False, "result":{"autoSave":True}}))
        payload={"action":"getSettings"}
        self.assertEqual(self.request('/v1/storage','POST',payload)[0],401)
        headers=self.auth(secret,payload,request_id='storage-1',path='/v1/storage')
        self.assertEqual(self.request('/v1/storage','POST',payload,headers)[0],202)
        self.bridge.storage.submit.assert_called_once_with('storage-1',payload)
        query={"requestId":"storage-1"}
        headers=self.auth(secret,query,request_id='poll-1',path='/v1/storage/result')
        self.assertTrue(self.request('/v1/storage/result','POST',query,headers)[2]['result']['autoSave'])
        bad={"action":"deleteAll"}
        headers=self.auth(secret,bad,request_id='bad',path='/v1/storage')
        self.assertEqual(self.request('/v1/storage','POST',bad,headers)[0],400)
        self.assertEqual(self.request('/v1/storage','OPTIONS')[0],204)

    def signed(self, secret, path, payload, request_id='test'):
        return self.request(path, 'POST', payload, self.auth(secret, payload, request_id=request_id, path=path))

    def test_project_contract_and_two_owner_project_read_isolation(self):
        get = {'action': 'get'}
        self.assertEqual(self.request('/v1/project', 'POST', get)[0], 401)
        secret = self.pair()
        first = self.signed(secret, '/v1/project', get)[2]['binding']
        self.assertEqual(first, self.bridge.project.binding.public())
        self.assertEqual(self.request('/v1/project', 'OPTIONS')[0], 204)
        for bad in [{}, {'action': 'get', 'extra': True}, {'action': 'bind'},
                    {'action': 'bind', 'renderUserId': 'alice', 'renderProjectId': 'two', 'expectedRevision': 1}]:
            self.assertEqual(self.signed(secret, '/v1/project', bad)[0], 400)
        for key, owner, project in [('a', 'alice', 'render-a'), ('b', 'alice', 'two'),
                                    ('c', 'bob', 'render-a'), ('d', 'bob', 'two'), ('legacy', None, None)]:
            self.bridge.feed.accept(key, key, project, owner)
            self.bridge.feed.fail(key, 'Done')
        self.bridge.preview = Obj(request=Mock(return_value={'pending': False}), pending=lambda: False)
        for key in ['b', 'c', 'd', 'legacy']:
            for path, payload in [('/v1/events', {'requestId': key, 'after': 0}),
                                  ('/v1/preview', {'requestId': key, 'afterRevision': 0})]:
                code, _, result = self.signed(secret, path, payload)
                self.assertEqual((code, result['error']['code']), (409, 'project_mismatch'))
        self.bridge.preview.request.assert_not_called()
        activity = lambda user: self.signed(secret, '/v1/activity', {'renderUserId': user, 'after': 0})[2]
        before = activity('alice')
        self.assertEqual([r['requestId'] for r in before['requests']], ['a'])
        self.assertIsNone(activity('bob')['binding'])
        self.assertEqual(activity('bob')['requests'], [])
        switch = {'action': 'bind', 'renderUserId': 'bob', 'renderProjectId': 'two', 'expectedRevision': first['revision']}
        self.assertEqual(self.signed(secret, '/v1/project', switch)[0], 200)
        self.assertEqual(activity('alice')['requests'], [])
        self.assertIsNone(activity('alice')['binding'])
        self.assertNotEqual(before['epoch'], activity('alice')['epoch'])
        self.assertEqual([r['requestId'] for r in activity('bob')['requests']], ['d'])
        self.assertEqual(self.signed(secret, '/v1/events', {'requestId': 'a', 'after': 0})[0], 409)
        self.assertEqual(self.signed(secret, '/v1/events', {'requestId': 'd', 'after': 0})[0], 200)
        self.assertEqual(self.signed(secret, '/v1/project', switch)[2]['error']['code'], 'project_binding_changed')

    def test_finished_activity_metadata_retains_owner_and_refreshes_without_feed_events(self):
        secret = self.pair()
        binding = self.bridge.project.binding.public()
        self.bridge.feed.accept('done', 'Build', 'render-a', 'alice')
        self.bridge.feed.observe({'bridgeRequestId': 'done', 'status': 'Ready'})
        def activity(owner, after=0):
            return self.signed(secret, '/v1/activity', {'renderUserId': owner, 'after': after})[2]
        result = activity('alice')
        self.assertFalse(result['busy'])
        self.assertTrue(result['availableForProjectChange'])
        self.assertEqual(result['binding'], binding)
        self.bridge.preview = Obj(pending=lambda: True)
        delta = activity('alice', result['cursor'])
        self.assertEqual(delta['requests'], [])
        self.assertTrue(delta['busy'])
        self.assertFalse(delta['availableForProjectChange'])
        hidden = activity('bob')
        self.assertIsNone(hidden['binding'])
        self.assertEqual(hidden['requests'], [])
        self.assertFalse(hidden['busy'])
        self.assertFalse(hidden['availableForProjectChange'])
        self.bridge.preview.pending = lambda: False
        final = activity('alice', result['cursor'])
        self.assertTrue(final['availableForProjectChange'])
        self.assertEqual(final['binding'], binding)
        self.assertEqual(self.signed(secret, '/v1/events', {'requestId': 'done', 'after': 0})[0], 200)

    def test_legacy_missing_revision_and_old_save_retries_cannot_bypass_lock(self):
        secret = self.pair()
        for payload, code in [({'prompt': 'Legacy'}, 'project_mismatch'),
                ({'prompt': 'No revision', 'renderUserId': 'alice', 'renderProjectId': 'render-a'}, 'project_binding_changed')]:
            status, _, result = self.signed(secret, '/v1/submissions', payload)
            self.assertEqual((status, result['error']['code']), (409, code))
        self.bridge.feed.accept('old', 'Old', 'two', 'alice')
        self.bridge.feed.fail('old', 'Save failed')
        self.bridge.storage = Obj(submit=Mock(), result=Mock(), saving=lambda: False, connection_busy=lambda: False)
        self.assertEqual(self.signed(secret, '/v1/storage', {'action': 'retrySave', 'requestId': 'old'})[0], 409)
        self.bridge.storage.submit.assert_not_called()
        self.bridge._save_retries['old-op'] = 'old'
        self.assertEqual(self.signed(secret, '/v1/storage/result', {'requestId': 'old-op'})[0], 409)
        self.bridge.storage.result.assert_not_called()
        self.bridge.feed.accept('current', 'Current', 'render-a', 'alice')
        self.bridge.feed.fail('current', 'Save failed')
        self.bridge._save_retries['current-op'] = 'current'
        self.bridge._pending_retries.add('current-op')
        self.bridge.storage.result.return_value = {'pending': False, 'result': {'retrying': True}}
        self.assertEqual(self.signed(secret, '/v1/storage/result', {'requestId': 'current-op'})[0], 200)
        self.assertNotIn('current-op', self.bridge._pending_retries)
        self.assertEqual(self.bridge._save_retries['current-op'], 'current')

    def test_close_is_clean_and_idempotent(self):
        self.bridge.close()
        self.bridge.close()
        self.assertEqual(self.bridge.status()["phase"], "stopped")


class MainThreadAdapterTests(unittest.TestCase):
    def test_pending_autosave_does_not_self_schedule_queued_bridge_events(self):
        from tests.test_clipboard_bridge import load_entry
        entry = load_entry()
        entry._running = True
        entry._event_pending = False
        entry._app = Obj(fireCustomEvent=Mock())
        storage = Obj(decorate=lambda state:state, saving=lambda:True)
        entry._external_bridge = Obj(storage=storage, feed=Obj(observe=Mock()),
            connection_info=lambda:{'busy':False,'queueDepth':1})
        entry._publish({})
        entry._app.fireCustomEvent.assert_called_once_with(entry.EVENT_ID)
        storage.saving=lambda:False
        entry._event_pending=False
        entry._app.fireCustomEvent.reset_mock()
        entry._publish({})
        self.assertEqual(entry._app.fireCustomEvent.call_count,2)

    def test_submission_message_defaults_to_current_folder_and_preserves_optional_target(self):
        current = Submission("one", "Make a bracket.", None, None, "Motor Mount")
        self.assertIn("Use the current Fusion Data Panel project and folder.", submission_message(current))
        self.assertIn("Requested design name: Motor Mount", submission_message(current))
        selected = Submission("two", "Make a bracket.", "project-1", "folder-2", None)
        framed = submission_message(selected)
        self.assertIn("explicitly selected Autodesk destination", framed)
        self.assertIn("Autodesk project ID: project-1", framed)
        self.assertIn("Autodesk folder ID: folder-2", framed)
        self.assertIn("silently falling back", framed)

    def test_handoff_preserves_plain_reference_urls_without_claiming_canvas_transfer(self):
        prompt = 'Build the mount.\nMotor: https://example.com/motor?size=34&revision=2\nImage: https://example.com/side.png'
        framed = submission_message(Submission('links', prompt, None, None, None), managed_save=True)
        self.assertTrue(framed.endswith(prompt))
        self.assertIn('not automatically attached Fusion canvases or image pixels', framed)
        self.assertIn('If your provider cannot open a link', framed)
        self.assertIn('Work only in the pinned document', framed)

    def test_adapter_dispatches_one_command_with_fusion_context_and_keeps_the_rest(self):
        from tests.test_clipboard_bridge import load_entry
        entry = load_entry()
        submissions = [Obj(kind="submit", submission=Submission("one", "First", None, None, "First Design")),
                       Obj(kind="submit", submission=Submission("two", "Second", None, None, None))]
        bridge = Obj(drain_commands=Mock(return_value=tuple(submissions)), requeue_commands=Mock())
        capture = Mock()
        controller = Obj(state={"busy": False}, dispatch=Mock(return_value=True))
        entry._dispatch_bridge_commands(bridge, controller, Obj(message_context=capture))
        sent = controller.dispatch.call_args.args[1]["text"]
        self.assertIn("Use the current Fusion Data Panel project and folder.", sent)
        self.assertIn("Requested design name: First Design", sent)
        self.assertTrue(sent.endswith("\nFirst"))
        self.assertTrue(callable(controller.dispatch.call_args.kwargs["capture_context"]))
        controller.dispatch.call_args.kwargs["capture_context"]("send")
        capture.assert_called_once_with("send")
        bridge.requeue_commands.assert_called_once_with((submissions[1],))

    def test_adapter_does_not_dispatch_while_controller_is_busy(self):
        from tests.test_clipboard_bridge import load_entry
        entry = load_entry()
        commands = (Obj(kind="submit", submission=Submission("later", "Later", None, None, None)),)
        bridge = Obj(drain_commands=Mock(return_value=commands), requeue_commands=Mock())
        controller = Obj(state={"busy": True}, dispatch=Mock())
        entry._dispatch_bridge_commands(bridge, controller, Obj(message_context=Mock()))
        controller.dispatch.assert_not_called()
        bridge.requeue_commands.assert_called_once_with(commands)

    def test_targeted_reply_waits_until_idle_and_passes_pinned_target(self):
        from tests.test_clipboard_bridge import load_entry
        from steve.external_bridge import BridgeCommand
        entry = load_entry()
        reply = Submission('reply', 'Follow up', None, None, None, 'one', 'alice', 'revision', 'original')
        command = BridgeCommand(1, 'submit', reply, ('chatgpt', 'linked'))
        bridge = Obj(drain_commands=Mock(return_value=(command,)), requeue_commands=Mock(), feed=Obj(fail=Mock()))
        controller = Obj(state={'busy': True}, dispatch=Mock(return_value=True))
        fusion = Obj(message_context=Mock())
        entry._dispatch_bridge_commands(bridge, controller, fusion)
        controller.dispatch.assert_not_called()
        bridge.requeue_commands.assert_called_with((command,))
        controller.state['busy'] = False
        entry._dispatch_bridge_commands(bridge, controller, fusion)
        self.assertEqual(controller.dispatch.call_args.args[1]['bridgeReplyTarget'], ('chatgpt', 'linked'))
        capture = controller.dispatch.call_args.kwargs['capture_context']
        bridge.feed.read = Mock(return_value={'snapshot': {'targetDocument': {'id': 'document'}}})
        bridge.storage = Obj(track=Mock())
        document = Obj(isValid=True)
        fusion.document_id = 'document'
        fusion.document = document
        fusion.app = Obj(activeDocument=object())
        with self.assertRaisesRegex(ValueError, 'target_document_mismatch'):
            capture('send')
        fusion.message_context.assert_not_called()
        bridge.storage.track.assert_not_called()
        fusion.app.activeDocument = document
        fusion.message_context.return_value = {'document_id': 'document', 'targetPinned': True}
        self.assertEqual(capture('send')['document_id'], 'document')
        fusion.message_context.assert_called_once_with('steer')
        bridge.storage.track.assert_called_once_with(reply, document)
        bridge.storage = None
        controller.dispatch.side_effect = ValueError('conversation_mismatch')
        with self.assertRaisesRegex(ValueError, 'conversation_mismatch'):
            entry._dispatch_bridge_commands(bridge, controller, fusion)
        self.assertEqual(bridge.feed.fail.call_args.args[0], 'reply')



class BridgeSettingsTests(unittest.TestCase):
    def test_failed_pairing_unlink_rolls_back_address_and_preserves_key(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            wake = Mock()
            bridge = ExternalBridge(wake, config_path=config)
            pairing = bridge.request_pairing()
            bridge.approve_pairing(pairing)
            original = bridge.complete_pairing(pairing)
            bridge.feed.accept('a', 'Keep this history', 'one', 'alice')
            bridge.feed.fail('a', 'Finished')
            baseline = bridge.feed.activity('alice', 0)
            wake.reset_mock()
            with patch.object(Path, 'unlink', side_effect=PermissionError('cannot unlink')):
                with self.assertRaises(PermissionError):
                    bridge.configure('https://staging.example')
            self.assertEqual(json.loads(config.read_text())['renderOrigin'], 'https://render3d.app')
            self.assertEqual(bridge.connection_info()['renderOrigin'], 'https://render3d.app')
            self.assertEqual(bridge._origins, {'https://render3d.app'})
            self.assertEqual(bridge._secret, original)
            self.assertEqual(bridge.status()['phase'], 'paired')
            self.assertEqual(bridge.feed.activity('alice', 0), baseline)
            restored = ExternalBridge(lambda: None, config_path=config)
            self.assertEqual(restored._secret, original)
            self.assertTrue(restored.status()['connected'])
            wake.assert_not_called()

    def test_failed_pairing_unlink_and_rollback_match_committed_address(self):
        import tempfile
        from steve.update_transaction import write_json
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            wake = Mock()
            bridge = ExternalBridge(wake, config_path=config)
            pairing = bridge.request_pairing()
            bridge.approve_pairing(pairing)
            original = bridge.complete_pairing(pairing)
            bridge.feed.accept('a', 'Old history', 'one', 'alice')
            bridge.feed.fail('a', 'Finished')
            wake.reset_mock()
            def fail_rollback(path, value):
                if path == config and value['renderOrigin'] == 'https://render3d.app':
                    raise OSError('cannot roll back')
                return write_json(path, value)
            with patch.object(Path, 'unlink', side_effect=PermissionError('cannot unlink')), \
                    patch('steve.update_transaction.write_json', side_effect=fail_rollback):
                with self.assertRaises(PermissionError):
                    bridge.configure('https://staging.example')
            self.assertEqual(json.loads(config.read_text())['renderOrigin'], 'https://staging.example')
            self.assertEqual(bridge.connection_info()['renderOrigin'], 'https://staging.example')
            self.assertEqual(bridge._origins, {'https://staging.example'})
            self.assertIsNone(bridge._secret)
            self.assertFalse(bridge.status()['connected'])
            self.assertTrue(bridge.connection_info()['configError'])
            self.assertEqual(bridge.feed.activity('alice', 0)['requests'], [])
            restored = ExternalBridge(lambda: None, config_path=config)
            self.assertEqual(restored.connection_info()['renderOrigin'], 'https://staging.example')
            self.assertFalse(restored.status()['connected'])
            self.assertNotIn(original, bridge.diagnostics())
            wake.assert_called_once_with()

    def test_failed_pairing_replacement_preserves_persisted_key(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            bridge = ExternalBridge(lambda: None, config_path=config)
            pairing = bridge.request_pairing()
            bridge.approve_pairing(pairing)
            original = bridge.complete_pairing(pairing)
            replacement = bridge.request_pairing()
            bridge.approve_pairing(replacement)
            with patch('steve.external_bridge.os.replace', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    bridge.complete_pairing(replacement)
            self.assertEqual(bridge._secret, original)
            self.assertEqual(ExternalBridge(lambda: None, config_path=config)._secret, original)
            self.assertEqual(list(Path(folder).glob('.render-pairing-*')), [])

    def test_failed_address_write_preserves_persisted_pairing(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            bridge = ExternalBridge(lambda: None, config_path=config)
            pairing = bridge.request_pairing()
            bridge.approve_pairing(pairing)
            original = bridge.complete_pairing(pairing)
            with patch('steve.update_transaction.write_json', side_effect=OSError('disk full')):
                with self.assertRaises(OSError):
                    bridge.configure('https://staging.example')
            self.assertEqual(bridge.connection_info()['renderOrigin'], 'https://render3d.app')
            self.assertEqual(bridge._secret, original)
            self.assertEqual(ExternalBridge(lambda: None, config_path=config)._secret, original)

    def test_pairing_survives_restart_privately_and_stays_out_of_status(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            bridge = ExternalBridge(lambda: None, config_path=config, clock=lambda: 1000)
            pairing = bridge.request_pairing()
            bridge.approve_pairing(pairing)
            secret = bridge.complete_pairing(pairing)
            self.assertEqual(config.with_name('render-pairing.json').stat().st_mode & 0o777, 0o600)
            bridge.close()
            restored = ExternalBridge(lambda: None, config_path=config, clock=lambda: 1001)
            self.assertTrue(restored.status()['connected'])
            self.assertEqual(restored._secret, secret)
            self.assertEqual(restored._auth_not_before, 1002)
            self.assertNotIn(secret, restored.diagnostics())
            self.assertNotIn(secret, json.dumps(restored.status()))

    def test_repair_requires_approval_and_denial_keeps_existing_key(self):
        bridge = ExternalBridge(lambda: None)
        pairing = bridge.request_pairing()
        bridge.approve_pairing(pairing)
        secret = bridge.complete_pairing(pairing)
        replacement = bridge.request_pairing()
        self.assertTrue(bridge.status()['connected'])
        self.assertEqual(bridge._secret, secret)
        bridge.deny_pairing(replacement)
        with self.assertRaises(BridgeError):
            bridge.complete_pairing(replacement)
        self.assertEqual(bridge._secret, secret)
        replacement = bridge.request_pairing()
        bridge.approve_pairing(replacement)
        self.assertNotEqual(bridge.complete_pairing(replacement), secret)

    def test_pairing_ignores_wrong_origin_corrupt_and_public_files(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            path = config.with_name('render-pairing.json')
            for value, mode in [('[]', 0o600), ('broken', 0o600),
                    (json.dumps({'renderOrigin':'https://other.example','secret':'x'*43}), 0o600),
                    (json.dumps({'renderOrigin':'https://render3d.app','secret':'x'*43}), 0o644)]:
                path.write_text(value)
                path.chmod(mode)
                self.assertFalse(ExternalBridge(lambda: None, config_path=config).status()['connected'])

    def test_address_persists_and_revokes_old_pairing(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'render-bridge.json'
            bridge = ExternalBridge(lambda: None, config_path=config)
            pairing = bridge.request_pairing()
            bridge.approve_pairing(pairing)
            secret = bridge.complete_pairing(pairing)
            bridge.configure('https://staging.example:443/')
            self.assertEqual(bridge.connection_info()['renderOrigin'], 'https://staging.example')
            self.assertFalse(bridge.status()['connected'])
            self.assertIsNone(bridge._secret)
            self.assertEqual(bridge._origins, {'https://staging.example'})
            self.assertNotIn(secret, bridge.diagnostics())
            restored = ExternalBridge(lambda: None, config_path=config)
            self.assertEqual(restored.connection_info()['renderOrigin'], 'https://staging.example')
            self.assertFalse(restored.status()['connected'])
            restored.configure('https://render3d.app')
            self.assertFalse(ExternalBridge(lambda: None, config_path=config).status()['connected'])

    def test_invalid_address_does_not_revoke_pairing(self):
        bridge = ExternalBridge(lambda: None)
        pairing = bridge.request_pairing()
        bridge.approve_pairing(pairing)
        bridge.complete_pairing(pairing)
        for value in ['*', 'https://user:pass@example.com', 'https://example.com/path',
                      'https://example.com?token=abc', 'file:' + '/' * 3 + 'tmp', 'https://*.example.com',
                      'https://example.com:invalid', None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                bridge.configure(value)
            self.assertTrue(bridge.status()['connected'])

    def test_activity_expires_without_discarding_pairing(self):
        now = [1000]
        bridge = ExternalBridge(lambda: None, clock=lambda: now[0])
        pairing = bridge.request_pairing()
        bridge.approve_pairing(pairing)
        bridge.complete_pairing(pairing)
        bridge._last_contact = now[0]
        self.assertTrue(bridge.connection_info()['browserActive'])
        now[0] += 91
        self.assertFalse(bridge.connection_info()['browserActive'])
        self.assertTrue(bridge.status()['connected'])

    def test_busy_config_change_preserves_address(self):
        bridge = ExternalBridge(lambda: None, readiness=lambda: {'busy': True})
        with self.assertRaises(ValueError):
            bridge.configure('http://localhost:5173')
        self.assertEqual(bridge.connection_info()['renderOrigin'], 'https://render3d.app')


if __name__ == "__main__":
    unittest.main()
