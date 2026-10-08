"""Bounded, request-scoped public chat feed; no account data or model reasoning."""
from collections import OrderedDict, deque
from copy import deepcopy
import threading
import json
import time
from pathlib import Path
from .update_transaction import write_json

from .debug_log import redact


class RenderFeed:
    def __init__(self, path=None):
        self._lock = threading.Lock()
        self._requests = OrderedDict()
        self._events = deque(maxlen=256)
        self._cursor = 0
        self.path = Path(path) if path else None
        self._last_save = 0
        if self.path and self.path.exists():
            try:
                if self.path.stat().st_size > 8_000_000:
                    raise ValueError('History exceeds limit')
                saved = json.loads(self.path.read_text())
                if not isinstance(saved, dict) or not isinstance(saved.get('requests'), list):
                    raise ValueError('Invalid history')
                for item in saved['requests'][-64:]:
                    if not isinstance(item, dict) or not isinstance(item.get('requestId'), str) or not isinstance(item.get('messages'), list) or not item['messages'] or not all(isinstance(m, dict) and 'id' in m for m in item['messages']):
                        continue
                    if item.get('phase') not in {'completed', 'failed', 'stopped'}:
                        item.update(phase='stopped', status='STEVE restarted; reopen the linked conversation.', activeTools=[])
                    self._requests[item['requestId']] = item
            except (OSError, ValueError, TypeError):
                pass

    def _persist(self, force=False):
        if not self.path or not force and time.monotonic() - self._last_save < 1:
            return
        records = list(self._requests.values())
        while len(json.dumps(records).encode()) > 7_500_000 and records:
            records.pop(0)
        try:
            write_json(self.path, {'version': 1, 'requests': records})
            self.path.chmod(0o600)
            self._last_save = time.monotonic()
        except OSError:
            pass

    def flush(self):
        with self._lock:
            self._persist(force=True)

    def clear(self):
        with self._lock:
            self._requests.clear()
            self._events.clear()
            self._persist(force=True)
            # Keep the cursor monotonic within the bridge lifetime.

    def _event(self, request_id, kind, data):
        self._cursor += 1
        self._events.append({"cursor": self._cursor, "requestId": request_id, "type": kind, **deepcopy(data)})

    def accept(self, request_id, prompt, render_project_id=None, render_user_id=None):
        with self._lock:
            item = {"requestId": request_id, "phase": "queued", "status": "Queued for Fusion",
                    "error": "", "messages": [{"id": "prompt", "role": "user", "text": redact(prompt)}],
                    "activeTools": [], "targetDocument": None}
            if render_project_id and render_user_id:
                item.update(renderProjectId=render_project_id, renderUserId=render_user_id)
            self._requests[request_id] = item
            while len(self._requests) > 64:
                self._requests.popitem(last=False)
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
                    and entry.get('provider') == state.get('provider')), None)
                linked = item is not None
                if linked:
                    request_id = item['requestId']
            if not item or (linked and state.get('showingOlderMessages')) or not linked and item["phase"] in {"completed", "failed", "stopped"}:
                return
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
            changed = any(item.get(k) != v for k, v in summary.items())
            if changed:
                item.update(summary)
                self._event(request_id, "status", summary)
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
                if previous.get(safe["id"]) != safe:
                    self._event(request_id, "message", {"message": safe})
            changed = changed or item["messages"] != messages or item.get("transcriptTruncated") != (offset > 1)
            item["messages"] = messages
            item["transcriptTruncated"] = offset > 1
            if changed:
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
