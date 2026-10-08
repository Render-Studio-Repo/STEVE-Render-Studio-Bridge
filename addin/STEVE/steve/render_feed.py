"""Bounded, request-scoped public chat feed; no account data or model reasoning."""
from collections import OrderedDict, deque
from copy import deepcopy
import threading

from .debug_log import redact


class RenderFeed:
    def __init__(self):
        self._lock = threading.Lock()
        self._requests = OrderedDict()
        self._events = deque(maxlen=256)
        self._cursor = 0

    def clear(self):
        with self._lock:
            self._requests.clear()
            self._events.clear()
            # Keep the cursor monotonic within the bridge lifetime.

    def _event(self, request_id, kind, data):
        self._cursor += 1
        self._events.append({"cursor": self._cursor, "requestId": request_id, "type": kind, **deepcopy(data)})

    def accept(self, request_id, prompt):
        with self._lock:
            item = {"requestId": request_id, "phase": "queued", "status": "Queued for Fusion",
                    "error": "", "messages": [{"id": "prompt", "role": "user", "text": redact(prompt)}],
                    "activeTools": [], "targetDocument": None}
            self._requests[request_id] = item
            while len(self._requests) > 64:
                self._requests.popitem(last=False)
            self._event(request_id, "status", {"phase": "queued", "status": item["status"]})

    def fail(self, request_id, message):
        with self._lock:
            item = self._requests.get(request_id)
            if item:
                item.update(phase="failed", error=redact(str(message))[:4000], status="Failed")
                self._event(request_id, "status", {k: item[k] for k in ("phase", "status", "error")})

    def observe(self, state):
        request_id = state.get("bridgeRequestId")
        with self._lock:
            item = self._requests.get(request_id)
            if not item or item["phase"] in {"completed", "failed", "stopped"}:
                return
            busy = bool(state.get("busy") or state.get("jobBusy"))
            phase = "running" if busy else "failed" if state.get("error") else "stopped" if state.get("status") == "Stopped" else "completed"
            document = state.get("taskDocument") or {}
            summary = {"phase": phase, "status": redact(str(state.get("status", "")))[:1000],
                       "error": redact(str(state.get("error", "")))[:4000],
                       "waitingForFusion": bool(state.get("waitingForFusion")),
                       "waitingReason": redact(str(state.get("waitingReason", "")))[:1000],
                       "targetDocument": {k: str(document[k])[:300] for k in ("id", "name") if document.get(k)} or None,
                       "activeTools": [{k: redact(str(t[k]))[:200] for k in ("id", "tool", "title", "name") if k in t}
                                       for t in state.get("activeTools", [])[:16]]}
            if any(item.get(k) != v for k, v in summary.items()):
                item.update(summary)
                self._event(request_id, "status", summary)
            previous = {m["id"]: m for m in item["messages"]}
            messages = [item["messages"][0]]
            # Index zero is the bridge's internal destination wrapper, not a user-facing message.
            offset = state.get("bridgeMessageOffset", 0)
            for index, message in enumerate(state.get("bridgeMessages", [])):
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
            item["messages"] = messages
            item["transcriptTruncated"] = offset > 1

    def read(self, request_id, after):
        with self._lock:
            item = self._requests.get(request_id)
            if item is None:
                raise KeyError(request_id)
            reset = after == 0 or after > self._cursor or (self._events and after < self._events[0]["cursor"] - 1)
            events = [] if reset else [e for e in self._events if e["cursor"] > after and e["requestId"] == request_id]
            return deepcopy({"version": 1, "cursor": self._cursor, "reset": bool(reset),
                             "snapshot": item if reset else None, "events": events})
