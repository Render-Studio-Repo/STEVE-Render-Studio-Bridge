"""Bounded, request-scoped public chat feed; no account data or model reasoning."""
from collections import OrderedDict, deque
from copy import deepcopy
from hashlib import sha256
import threading
import json
import os
import time
from uuid import uuid4
from pathlib import Path
from .update_transaction import write_json

from .debug_log import redact

MAX_HISTORY_BYTES = 7_500_000
MAX_REQUESTS = 64


class RenderFeed:
    def __init__(self, path=None, render_origin=None):
        self._lock = threading.Lock()
        self._requests = OrderedDict()
        self._observed_signatures = {}
        self._events = deque(maxlen=256)
        self._cursor = 0
        self._epoch = uuid4().hex
        self.path = Path(path) if path else None
        self._last_save = 0
        self._origin = render_origin
        if self.path and self.path.exists():
            try:
                if self.path.stat().st_size > 8_000_000:
                    raise ValueError('History exceeds limit')
                saved = json.loads(self.path.read_text())
                if not isinstance(saved, dict) or not isinstance(saved.get('requests'), list):
                    raise ValueError('Invalid history')
                if 'renderOrigin' in saved and saved['renderOrigin'] != self._origin:
                    raise ValueError('History belongs to another Render origin')
                for item in saved['requests'][-MAX_REQUESTS:]:
                    if not isinstance(item, dict) or not isinstance(item.get('requestId'), str) or not isinstance(item.get('messages'), list) or not item['messages'] or not all(isinstance(m, dict) and 'id' in m for m in item['messages']):
                        continue
                    if item.get('phase') not in {'completed', 'failed', 'stopped'}:
                        item.update(phase='stopped', status='STEVE restarted; reopen the linked conversation.', activeTools=[])
                    self._requests[item['requestId']] = item
            except (OSError, ValueError, TypeError):
                pass
        self._bound_history()

    def _bound_history(self):
        sizes = {key: len(json.dumps(item).encode()) for key, item in self._requests.items()}
        total = sum(sizes.values()) + 2 * len(sizes)
        for key, item in self._requests.items():
            if total <= MAX_HISTORY_BYTES:
                break
            original = sizes[key]
            size = original
            while size > MAX_HISTORY_BYTES - (total - original) and len(item['messages']) > 1:
                removed = item['messages'].pop(1)
                size -= len(json.dumps(removed).encode()) + 2
            if size != original:
                item['transcriptTruncated'] = True
                total += len(json.dumps(item).encode()) - original
                self._event(key, 'status', {'transcriptTruncated': True})
        while total > MAX_HISTORY_BYTES and self._requests:
            key, item = self._requests.popitem(last=False)
            self._observed_signatures.pop(key, None)
            self._epoch = uuid4().hex
            total -= len(json.dumps(item).encode()) + 2

    def _persist(self, force=False, required=False):
        self._bound_history()
        if not self.path or not force and time.monotonic() - self._last_save < 1:
            return
        records = list(self._requests.values())
        while len(json.dumps(records).encode()) > MAX_HISTORY_BYTES and records:
            records.pop(0)
        try:
            if required:
                self.path.parent.mkdir(parents=True, exist_ok=True)
            packet = {'version': 1, 'requests': records}
            if self._origin is not None:
                packet['renderOrigin'] = self._origin
            write_json(self.path, packet)
            self.path.chmod(0o600)
            if required:
                with self.path.open("rb") as stream:
                    os.fsync(stream.fileno())
            self._last_save = time.monotonic()
        except OSError:
            if required:
                raise

    def flush(self):
        with self._lock:
            self._persist(force=True)

    def ensure_origin(self, origin):
        """Persist old-origin provenance before any configuration commit.

        Legacy untagged history may be retained at startup, but must never
        survive an origin change without this durable provenance barrier.
        """
        with self._lock:
            previous = self._origin
            self._origin = origin
            try:
                self._persist(force=True, required=True)
            except OSError:
                self._origin = previous
                raise

    def clear(self, render_origin=None):
        with self._lock:
            if render_origin is not None:
                self._origin = render_origin
            self._requests.clear()
            self._observed_signatures.clear()
            self._events.clear()
            self._epoch = uuid4().hex
            self._persist(force=True)
            # Keep the cursor monotonic within the bridge lifetime.

    def _event(self, request_id, kind, data):
        self._cursor += 1
        self._events.append({"cursor": self._cursor, "requestId": request_id, "type": kind, **deepcopy(data)})

    def accept(self, request_id, prompt, render_project_id=None, render_user_id=None, *, reply_to_request_id=None, reply_target=None):
        with self._lock:
            item = {"requestId": request_id, "phase": "queued", "status": "Queued for Fusion",
                    "error": "", "messages": [{"id": "prompt", "role": "user", "text": redact(prompt)}],
                    "activeTools": [], "targetDocument": None}
            if render_project_id and render_user_id:
                item.update(renderProjectId=render_project_id, renderUserId=render_user_id)
            if reply_target is not None:
                item.update(replyToRequestId=reply_to_request_id, provider=reply_target[0], threadId=reply_target[1])
            self._requests[request_id] = item
            self._observed_signatures.pop(request_id, None)
            while len(self._requests) > MAX_REQUESTS:
                evicted, _ = self._requests.popitem(last=False)
                self._observed_signatures.pop(evicted, None)
                self._epoch = uuid4().hex
            self._event(request_id, "status", {"phase": "queued", "status": item["status"]})
            self._persist(force=True)

    def fail(self, request_id, message):
        with self._lock:
            item = self._requests.get(request_id)
            if item:
                item.update(phase="failed", error=redact(str(message))[:4000], status="Failed")
                self._event(request_id, "status", {k: item[k] for k in ("phase", "status", "error")})
                self._persist(force=True)

    def observe(self, state):
        request_id = state.get("bridgeRequestId")
        with self._lock:
            item = self._requests.get(request_id)
            linked = False
            if not item and state.get('threadId'):
                item = next((entry for entry in reversed(self._requests.values())
                    if entry.get('renderProjectId') and entry.get('threadId') == state['threadId']
                    and entry.get('provider') == state.get('provider') and entry.get('phase') != 'queued'
                    and (not entry.get('replyToRequestId') or entry.get('replyDispatched') is True)), None)
                linked = item is not None
                if linked:
                    request_id = item['requestId']
            if not item or (linked and state.get('showingOlderMessages')) or not linked and item["phase"] in {"completed", "failed", "stopped"}:
                return
            # Enqueue pins identity, not proof of a delivered turn. A rejected
            # reply must never inherit an old answer through thread fallback.
            if (not linked and item.get('replyToRequestId') and state.get('bridgeMessages')
                    and state.get('threadId') == item.get('threadId')
                    and state.get('provider') == item.get('provider')):
                item['replyDispatched'] = True
            if state.get('threadId') and not state.get('bridgeSendQueued'):
                item.setdefault('threadId', state['threadId'])
                item.setdefault('provider', state.get('provider'))
                item.setdefault('messageStart', state.get('bridgeMessageStart', 0))
            busy = bool(state.get("busy") or state.get("jobBusy"))
            phase = "saving" if state.get("bridgeSaving") else "queued" if state.get("bridgeSendQueued") and not busy else "running" if busy else "failed" if state.get("error") else "stopped" if state.get("status") == "Stopped" else "completed"
            document = state.get("taskDocument") or {}
            summary = {"phase": phase, "status": redact(str(state.get("status", "")))[:1000],
                       "error": redact(str(state.get("error", "")))[:4000],
                       "waitingForFusion": bool(state.get("waitingForFusion")),
                       "waitingReason": redact(str(state.get("waitingReason", "")))[:1000],
                       "targetDocument": {k: str(document[k])[:300] for k in ("id", "name") if document.get(k)} or None,
                       "activeTools": [{k: redact(str(t[k]))[:200] for k in ("id", "tool", "title", "name") if k in t}
                                       for t in state.get("activeTools", [])[:16]]}
            for key in ('threadId', 'renderProjectId', 'renderUserId'):
                if item.get(key):
                    summary[key] = item[key]
            if linked and busy:
                summary['save'] = None
            previous_cursor = self._cursor
            changed = any(item.get(k) != v for k, v in summary.items())
            previous = {m["id"]: m for m in item["messages"]}
            messages = [item["messages"][0]]
            # Index zero is the bridge's internal destination wrapper, not a user-facing message.
            offset = state.get("bridgeMessageOffset", 0)
            source = state.get("bridgeMessages", [])
            if linked:
                if state.get('showingOlderMessages'):
                    return
                start = item.get('messageStart', 0)
                first = state.get('messageOffset', 0)
                source = state.get('messages', [])[max(0, start-first):]
                offset = max(0, first-start)
            for index, message in enumerate(source):
                position = offset + index
                if position == 0 or message.get("role") not in {"user", "assistant", "tool"}:
                    continue
                safe = {"id": str(message.get("id") or f"message-{position}")[:200], "role": message["role"]}
                for key in ("text", "title", "tool", "toolStatus", "delivery"):
                    if isinstance(message.get(key), str):
                        safe[key] = redact(message[key])[:32000 if key == "text" else 300]
                if len(str(message.get("text", ""))) > 32000:
                    safe["truncated"] = True
                messages.append(safe)
            # An identical controller publication must not re-add transcript
            # messages discarded by the aggregate byte budget.
            signature = sha256(json.dumps([summary, messages, offset]).encode()).digest()
            if not changed and self._observed_signatures.get(request_id) == signature:
                return
            self._observed_signatures[request_id] = signature
            if changed:
                item.update(summary)
                self._event(request_id, "status", summary)
            for safe in messages[1:]:
                if previous.get(safe["id"]) != safe:
                    self._event(request_id, "message", {"message": safe})
            changed = changed or item["messages"] != messages or item.get("transcriptTruncated") != (offset > 1)
            item["messages"] = messages
            item["transcriptTruncated"] = offset > 1
            if changed:
                # Message removal/window movement must also advance activity.
                if self._cursor == previous_cursor:
                    self._event(request_id, 'status', {'transcriptTruncated': offset > 1})
                self._persist(force=phase in {'completed', 'failed', 'stopped'})

    def save_status(self, request_id, save, phase):
        with self._lock:
            item = self._requests.get(request_id)
            if item is None:
                return
            status = {"phase": phase, "save": save, "error": ""}
            if phase == "failed":
                status["error"] = save.get("message", "Autosave failed")
            if any(item.get(k) != v for k, v in status.items()):
                item.update(deepcopy(status))
                self._event(request_id, "status", status)
                self._persist(force=True)

    def project_state(self):
        """Retained owner pairs and nonterminal work, including drained dispatches."""
        with self._lock:
            owners = set()
            ambiguous = False
            for item in self._requests.values():
                if 'renderUserId' not in item and 'renderProjectId' not in item:
                    continue  # Pure legacy, unowned history carries no association.
                user, project = item.get('renderUserId'), item.get('renderProjectId')
                if (not isinstance(user, str) or not user.strip() or len(user) > 256
                        or not isinstance(project, str) or not project.strip() or len(project) > 256):
                    ambiguous = True
                else:
                    owners.add((user, project))
            if ambiguous:
                owners.clear()  # Explicit selection is required for uncertain ownership.
            busy = any(r.get('phase') not in {'completed', 'failed', 'stopped'}
                       for r in self._requests.values())
            return owners, busy

    def project_finished(self, project_id, user_id):
        """Engine request completion, never an inference about assistant prose."""
        with self._lock:
            item = next((entry for entry in reversed(self._requests.values())
                         if entry.get('renderProjectId') == project_id
                         and entry.get('renderUserId') == user_id), None)
            return bool(item and item.get('phase') == 'completed'
                        and not item.get('error') and not item.get('waitingForFusion')
                        and not item.get('activeTools')
                        and item.get('status') not in {'Needs attention', 'Stopped'}
                        and (not item.get('save') or item['save'].get('state') in {'saved', 'unchanged'})
                        and not any(m.get('delivery') in {'pending', 'failed'} for m in item['messages']))

    def activity(self, user_id, after):
        """Full public snapshots for exactly one owner, across all projects.

        Clients must compare epoch and re-read after=0 when it changes: a
        restarted process can pass the previous cursor before the next poll.
        """
        with self._lock:
            reset = after == 0 or after > self._cursor or (self._events and after < self._events[0]['cursor'] - 1)
            changed = {event['requestId'] for event in self._events if event['cursor'] > after}
            requests = [item for key, item in self._requests.items()
                        if item.get('renderUserId') == user_id and (reset or key in changed)]
            return deepcopy({'version': 1, 'cursor': self._cursor, 'epoch': self._epoch,
                             'reset': bool(reset), 'requests': requests})

    def latest(self, project_id, user_id):
        with self._lock:
            item = next((entry for entry in reversed(self._requests.values())
                if entry.get('renderProjectId') == project_id and entry.get('renderUserId') == user_id), None)
            if item is None:
                raise KeyError(project_id)
            return deepcopy({'version': 1, 'cursor': self._cursor, 'reset': True, 'snapshot': item, 'events': []})

    def read(self, request_id, after):
        with self._lock:
            item = self._requests.get(request_id)
            if item is None:
                raise KeyError(request_id)
            reset = after == 0 or after > self._cursor or (self._events and after < self._events[0]["cursor"] - 1)
            events = [] if reset else [e for e in self._events if e["cursor"] > after and e["requestId"] == request_id]
            return deepcopy({"version": 1, "cursor": self._cursor, "reset": bool(reset),
                             "snapshot": item if reset else None, "events": events})
