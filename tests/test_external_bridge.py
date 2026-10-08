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
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "addin/STEVE"))
from steve.external_bridge import ExternalBridge, MAX_QUEUE_SIZE, Submission, submission_message


ORIGIN = "http://render-studio.test"


class BridgeHTTPTests(unittest.TestCase):
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
        return result["secret"]

    def auth(self, secret, body, request_id="request-1", nonce=None, timestamp=None):
        nonce = nonce or uuid4().hex
        timestamp = str(timestamp or int(time.time()))
        body_bytes = json.dumps(body, separators=(",", ":")).encode()
        digest = sha256(body_bytes).hexdigest()
        signed = f"POST\n/v1/submissions\n{timestamp}\n{nonce}\n{request_id}\n{digest}".encode()
        return {
            "X-Request-Id": request_id,
            "X-Steve-Timestamp": timestamp,
            "X-Steve-Nonce": nonce,
            "X-Steve-Signature": hmac.new(secret.encode(), signed, sha256).hexdigest(),
        }

    def submit(self, secret, body, request_id="request-1", nonce=None, timestamp=None):
        return self.request("/v1/submissions", "POST", body,
                            self.auth(secret, body, request_id, nonce, timestamp))

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
            "capabilities": {"submitPrompt": True, "destinationMetadata": True, "createFolder": False, "chatEvents": True},
            "queueDepth": 0,
        })
        self.assertNotIn("secret", json.dumps(result).lower())

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
        self.bridge.configure('http://localhost:5173')
        self.assertEqual(event_request(payload)[0], 403)

    def test_close_is_clean_and_idempotent(self):
        self.bridge.close()
        self.bridge.close()
        self.assertEqual(self.bridge.status()["phase"], "stopped")


class MainThreadAdapterTests(unittest.TestCase):
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
        self.assertEqual(controller.dispatch.call_args.kwargs, {"capture_context": capture})
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



class BridgeSettingsTests(unittest.TestCase):
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
