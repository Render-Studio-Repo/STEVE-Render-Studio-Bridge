"""Authenticated Render Studio bridge with no Fusion-thread access."""
from collections import OrderedDict, deque
from dataclasses import dataclass
from enum import Enum
from hashlib import sha256
import hmac
from http.server import BaseHTTPRequestHandler
import json
import secrets
import threading
import time
from urllib.parse import urlsplit

from .loopback_http import ThreadingLoopbackHTTPServer


PROTOCOL_VERSION = 1
BRIDGE_PORT = 38173
PRODUCTION_ORIGINS = frozenset({"https://render3d.app"})
MAX_BODY_BYTES = 64 * 1024
MAX_PROMPT_CHARS = 32_000
MAX_QUEUE_SIZE = 16
MAX_REQUEST_ID_CHARS = 128
AUTH_WINDOW_SECONDS = 60
NONCE_CACHE_SIZE = 1024
IDEMPOTENCY_CACHE_SIZE = 256


class ConnectionPhase(str, Enum):
    UNPAIRED = "unpaired"
    PAIRING_PENDING = "pairing_pending"
    PAIRING_APPROVED = "pairing_approved"
    PAIRED = "paired"
    PAIRING_DENIED = "pairing_denied"
    STOPPED = "stopped"


@dataclass(frozen=True)
class ConnectionState:
    version: int
    phase: ConnectionPhase
    pairing_id: str | None = None


@dataclass(frozen=True)
class Submission:
    request_id: str
    prompt: str
    project_id: str | None
    folder_id: str | None
    design_name: str | None


@dataclass(frozen=True)
class BridgeCommand:
    version: int
    kind: str
    submission: Submission


def submission_message(submission):
    """Frame a Render Studio handoff without inventing a second controller path."""
    destination = "Use the current Fusion Data Panel project and folder."
    if submission.project_id or submission.folder_id:
        destination = (
            "Use the explicitly selected Autodesk destination below. Resolve it through the signed-in "
            "Fusion Data API before saving, and stop with a clear error instead of silently falling back."
        )
    lines = [
        "[Render Studio CAD handoff]",
        destination,
        f"Autodesk project ID: {submission.project_id or 'current'}",
        f"Autodesk folder ID: {submission.folder_id or 'current'}",
        f"Requested design name: {submission.design_name or 'derive a concise name from the request'}",
        "Treat the destination and name as delivery instructions, not as part geometry.",
        "",
        submission.prompt,
    ]
    return "\n".join(lines)


class BridgeError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code


def _text(value, field, maximum, required=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > maximum:
        raise BridgeError(400, "invalid_request", f"Invalid {field}.")
    return value


def _submission(payload, request_id):
    if not isinstance(payload, dict) or set(payload) - {"prompt", "projectId", "folderId", "designName"}:
        raise BridgeError(400, "invalid_request", "Invalid submission fields.")
    return Submission(
        request_id=request_id,
        prompt=_text(payload.get("prompt"), "prompt", MAX_PROMPT_CHARS, required=True),
        project_id=_text(payload.get("projectId"), "projectId", 256),
        folder_id=_text(payload.get("folderId"), "folderId", 256),
        design_name=_text(payload.get("designName"), "designName", 256),
    )


class ExternalBridge:
    """Owns bridge state, authentication, idempotency, and the command queue."""

    def __init__(self, wake_main_thread, readiness=None, origins=(), port=BRIDGE_PORT, clock=time.time):
        self._wake_main_thread = wake_main_thread
        self._readiness = readiness or (lambda: {})
        self._origins = frozenset(PRODUCTION_ORIGINS | frozenset(origins))
        self._port = port
        self._clock = clock
        self._lock = threading.Lock()
        self._state = ConnectionState(PROTOCOL_VERSION, ConnectionPhase.UNPAIRED)
        self._pending_secret = None
        self._secret = None
        self._commands = deque()
        self._nonces = OrderedDict()
        self._requests = OrderedDict()
        self._server = None
        self._thread = None

    @property
    def port(self):
        return self._server.server_port if self._server else self._port

    def start(self):
        with self._lock:
            if self._server:
                return
            bridge = self

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    bridge._handle(self)

                def do_POST(self):
                    bridge._handle(self)

                def do_OPTIONS(self):
                    bridge._handle(self)

                def log_message(self, format, *args):
                    return

            self._server = ThreadingLoopbackHTTPServer(("127.0.0.1", self._port), Handler)
            self._thread = threading.Thread(target=self._server.serve_forever, daemon=True, name="STEVE-External-Bridge")
            self._thread.start()

    def close(self):
        with self._lock:
            server, thread = self._server, self._thread
            self._server = self._thread = None
            self._state = ConnectionState(PROTOCOL_VERSION, ConnectionPhase.STOPPED)
            self._pending_secret = self._secret = None
            self._commands.clear()
        if server:
            server.shutdown()
            server.server_close()
        if thread and thread is not threading.current_thread():
            thread.join(timeout=2)

    def status(self):
        readiness = self._readiness()
        if not isinstance(readiness, dict):
            readiness = {}
        with self._lock:
            state = self._state
            return {
                "version": state.version,
                "phase": state.phase.value,
                "connected": state.phase is ConnectionPhase.PAIRED,
                "fusionRunning": bool(readiness.get("fusionRunning", True)),
                "providerReady": bool(readiness.get("providerReady", False)),
                "busy": bool(readiness.get("busy", False)),
                "ready": state.phase is ConnectionPhase.PAIRED and bool(readiness.get("providerReady", False)),
                "pairingId": state.pairing_id,
                "capabilities": {"submitPrompt": True, "destinationMetadata": True, "createFolder": False},
                "queueDepth": len(self._commands),
            }

    def request_pairing(self):
        wake = False
        with self._lock:
            if self._state.phase is ConnectionPhase.STOPPED:
                raise BridgeError(503, "stopped", "The bridge is stopped.")
            if self._state.phase is ConnectionPhase.PAIRED:
                raise BridgeError(409, "already_paired", "Render Studio is already paired.")
            if self._state.phase in {ConnectionPhase.PAIRING_PENDING, ConnectionPhase.PAIRING_APPROVED}:
                return self._state.pairing_id
            pairing_id = secrets.token_urlsafe(24)
            self._pending_secret = None
            self._state = ConnectionState(PROTOCOL_VERSION, ConnectionPhase.PAIRING_PENDING, pairing_id)
            wake = True
        if wake:
            self._wake_main_thread()
        return pairing_id

    def approve_pairing(self, pairing_id):
        with self._lock:
            if self._state.phase is not ConnectionPhase.PAIRING_PENDING or self._state.pairing_id != pairing_id:
                raise BridgeError(409, "pairing_changed", "The pairing request is no longer pending.")
            self._pending_secret = secrets.token_urlsafe(32)
            self._state = ConnectionState(PROTOCOL_VERSION, ConnectionPhase.PAIRING_APPROVED, pairing_id)

    def deny_pairing(self, pairing_id):
        with self._lock:
            if self._state.phase is not ConnectionPhase.PAIRING_PENDING or self._state.pairing_id != pairing_id:
                raise BridgeError(409, "pairing_changed", "The pairing request is no longer pending.")
            self._pending_secret = None
            self._state = ConnectionState(PROTOCOL_VERSION, ConnectionPhase.PAIRING_DENIED, pairing_id)

    def complete_pairing(self, pairing_id):
        with self._lock:
            if self._state.pairing_id != pairing_id:
                raise BridgeError(404, "pairing_not_found", "Pairing request not found.")
            if self._state.phase is ConnectionPhase.PAIRING_PENDING:
                raise BridgeError(409, "pairing_pending", "Pairing approval is pending.")
            if self._state.phase is ConnectionPhase.PAIRING_DENIED:
                self._state = ConnectionState(PROTOCOL_VERSION, ConnectionPhase.UNPAIRED)
                raise BridgeError(403, "pairing_denied", "Pairing was denied.")
            if self._state.phase is not ConnectionPhase.PAIRING_APPROVED or not self._pending_secret:
                raise BridgeError(410, "pairing_complete", "Pairing was already completed.")
            secret = self._pending_secret
            self._pending_secret = None
            self._secret = secret
            self._nonces.clear()
            self._requests.clear()
            self._state = ConnectionState(PROTOCOL_VERSION, ConnectionPhase.PAIRED)
            return secret

    def drain_commands(self):
        with self._lock:
            commands = tuple(self._commands)
            self._commands.clear()
            return commands

    def requeue_commands(self, commands):
        with self._lock:
            for command in reversed(tuple(commands)):
                self._commands.appendleft(command)

    def _authenticate(self, handler, body):
        timestamp = handler.headers.get("X-Steve-Timestamp", "")
        nonce = handler.headers.get("X-Steve-Nonce", "")
        signature = handler.headers.get("X-Steve-Signature", "")
        request_id = handler.headers.get("X-Request-Id", "")
        if not request_id or len(request_id) > MAX_REQUEST_ID_CHARS or not nonce or len(nonce) > 128:
            raise BridgeError(401, "invalid_auth", "Authentication headers are invalid.")
        try:
            timestamp_number = int(timestamp)
        except ValueError:
            raise BridgeError(401, "invalid_auth", "Authentication headers are invalid.")
        if abs(self._clock() - timestamp_number) > AUTH_WINDOW_SECONDS:
            raise BridgeError(401, "expired", "The request timestamp is outside the allowed window.")
        body_hash = sha256(body).hexdigest()
        signed = f"{handler.command}\n{handler.path}\n{timestamp}\n{nonce}\n{request_id}\n{body_hash}".encode()
        with self._lock:
            secret = self._secret
            if self._state.phase is not ConnectionPhase.PAIRED or not secret:
                raise BridgeError(401, "not_paired", "Pair Render Studio with STEVE first.")
            expected = hmac.new(secret.encode(), signed, sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise BridgeError(401, "invalid_signature", "The request signature is invalid.")
            if nonce in self._nonces:
                raise BridgeError(409, "replay", "The request nonce was already used.")
            self._nonces[nonce] = timestamp_number
            while len(self._nonces) > NONCE_CACHE_SIZE:
                self._nonces.popitem(last=False)
        return request_id, body_hash

    def _enqueue(self, submission, body_hash):
        wake = False
        with self._lock:
            prior = self._requests.get(submission.request_id)
            if prior:
                if prior != body_hash:
                    raise BridgeError(409, "request_id_conflict", "The request ID was used with different content.")
                return False
            if len(self._commands) >= MAX_QUEUE_SIZE:
                raise BridgeError(429, "queue_full", "STEVE's submission queue is full.")
            self._commands.append(BridgeCommand(PROTOCOL_VERSION, "submit", submission))
            self._requests[submission.request_id] = body_hash
            while len(self._requests) > IDEMPOTENCY_CACHE_SIZE:
                self._requests.popitem(last=False)
            wake = True
        if wake:
            self._wake_main_thread()
        return True

    def _handle(self, handler):
        try:
            origin = handler.headers.get("Origin")
            host = handler.headers.get("Host")
            allowed_hosts = {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}
            if host not in allowed_hosts:
                raise BridgeError(403, "invalid_host", "Host is not allowed.")
            if origin not in self._origins:
                raise BridgeError(403, "invalid_origin", "Origin is not allowed.")
            if handler.command == "OPTIONS":
                if handler.path not in {"/v1/status", "/v1/pairing/request", "/v1/pairing/complete", "/v1/submissions"}:
                    raise BridgeError(404, "not_found", "Route not found.")
                self._send(handler, 204, None, origin)
                return
            body = b""
            if handler.command == "POST":
                content_type = handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                if content_type != "application/json":
                    raise BridgeError(415, "invalid_content_type", "Content-Type must be application/json.")
                try:
                    length = int(handler.headers.get("Content-Length", ""))
                except ValueError:
                    raise BridgeError(400, "invalid_length", "Content-Length is required.")
                if length < 0 or length > MAX_BODY_BYTES:
                    raise BridgeError(413, "body_too_large", "The request body is too large.")
                body = handler.rfile.read(length)
            if handler.command == "GET" and handler.path == "/v1/status":
                result, status = self.status(), 200
            elif handler.command == "POST" and handler.path == "/v1/pairing/request":
                if body not in (b"", b"{}"):
                    raise BridgeError(400, "invalid_request", "The pairing request body must be empty.")
                result, status = {"version": PROTOCOL_VERSION, "pairingId": self.request_pairing()}, 202
            elif handler.command == "POST" and handler.path == "/v1/pairing/complete":
                payload = self._json(body)
                if set(payload) != {"pairingId"}:
                    raise BridgeError(400, "invalid_request", "Invalid pairing completion.")
                result, status = {"version": PROTOCOL_VERSION, "secret": self.complete_pairing(payload["pairingId"])}, 200
            elif handler.command == "POST" and handler.path == "/v1/submissions":
                request_id, body_hash = self._authenticate(handler, body)
                submission = _submission(self._json(body), request_id)
                accepted = self._enqueue(submission, body_hash)
                result, status = {"version": PROTOCOL_VERSION, "requestId": request_id, "accepted": accepted}, 202 if accepted else 200
            else:
                raise BridgeError(404, "not_found", "Route not found.")
            self._send(handler, status, result, origin)
        except BridgeError as error:
            self._send(handler, error.status, {"error": {"code": error.code, "message": str(error)}}, handler.headers.get("Origin"))
        except Exception:
            self._send(handler, 500, {"error": {"code": "internal_error", "message": "The bridge could not process the request."}}, handler.headers.get("Origin"))

    @staticmethod
    def _json(body):
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise BridgeError(400, "invalid_json", "The request body must be valid JSON.")
        if not isinstance(payload, dict):
            raise BridgeError(400, "invalid_json", "The request body must be a JSON object.")
        return payload

    def _send(self, handler, status, payload, origin):
        data = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        handler.send_response(status)
        if origin in self._origins:
            handler.send_header("Access-Control-Allow-Origin", origin)
            handler.send_header("Vary", "Origin")
            handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            handler.send_header("Access-Control-Allow-Headers", "Content-Type, X-Request-Id, X-Steve-Timestamp, X-Steve-Nonce, X-Steve-Signature")
            if handler.headers.get("Access-Control-Request-Private-Network") == "true":
                handler.send_header("Access-Control-Allow-Private-Network", "true")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        if data:
            handler.wfile.write(data)
