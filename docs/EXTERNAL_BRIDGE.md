# Render Studio bridge protocol

The external bridge lets Render Studio submit a prompt to STEVE after the user approves a local pairing request. STEVE starts the bridge with its Fusion add-in and stops it when the add-in stops.

The bridge listens only on `127.0.0.1:38173`. It accepts browser requests from the exact Render origin configured in STEVE, defaulting to `https://render3d.app`. Tests and development tools can inject other exact origins when they construct `ExternalBridge`. See [installation with an AI assistant](INSTALL_WITH_AI.md) for first-time setup.

## Check the connection

Send `GET /v1/status` with the `Origin` header. The response reports protocol version `1`, the connection phase, Fusion and provider readiness, current busy state, the command queue depth, and supported capabilities. `ready` becomes true only after pairing while STEVE's selected provider is signed in and connected. The response never returns a pairing secret or a prompt.

The connection phases are `unpaired`, `pairing_pending`, `pairing_approved`, `paired`, `pairing_denied`, and `stopped`.

The default destination is the current Fusion Data Panel project and folder. A client may provide an existing Autodesk project and folder ID from an optional browser. STEVE resolves an explicit destination through the signed-in Fusion Data API and must report an error instead of silently falling back to the current folder. STEVE does not create Autodesk project folders in version 1. Check `capabilities.createFolder` before offering that action.

## Pair Render Studio

1. Send `POST /v1/pairing/request` with `{}`.
2. Show the returned `pairingId` to the user.
3. Ask the user to approve the same request in STEVE. The STEVE panel calls `externalBridgeApprove` or `externalBridgeDeny` with the `pairingId`.
4. Poll `POST /v1/pairing/complete` with `{"pairingId":"..."}`.
5. Store the returned secret in browser storage that is unavailable to ordinary page scripts when possible. Do not use `localStorage`.

The completion endpoint returns the secret once. Restarting STEVE clears the in-memory pairing and requires a new approval. A later change can add credential-store persistence without changing the wire protocol.

## Sign a submission

Send `POST /v1/submissions` with these headers:

- `X-Request-Id` contains a stable ID for idempotent retries.
- `X-Steve-Timestamp` contains the current Unix timestamp in seconds.
- `X-Steve-Nonce` contains a new random value for every attempt.
- `X-Steve-Signature` contains the lowercase hexadecimal HMAC-SHA256 signature.

Build the signed bytes from six newline-separated fields:

```text
POST
/v1/submissions
<timestamp>
<nonce>
<request-id>
<sha256-of-exact-body-bytes>
```

Use the pairing secret as the HMAC key. STEVE accepts timestamps within 60 seconds of its clock and rejects a reused nonce. A retry with the same request ID and the same body returns `accepted: false` without queuing a second command. Reusing a request ID with a different body returns `request_id_conflict`.

The JSON body has this shape:

```json
{
  "prompt": "Create a mounting bracket with two 5 mm holes.",
  "projectId": "optional Autodesk project ID",
  "folderId": "optional Autodesk folder ID",
  "designName": "optional design name"
}
```

The prompt limit is 32,000 characters. The complete body limit is 65,536 bytes. STEVE holds at most 16 accepted commands while Fusion is busy.

STEVE frames the destination and requested name as delivery instructions before sending the request through its existing controller. With no IDs, it uses the Data Panel context captured when the prompt is accepted. With IDs, the model must resolve and verify that existing destination before saving.

## Browser security rules

Every request requires an exact allowed `Origin` and a `Host` of either `127.0.0.1:38173` or `localhost:38173`. The bridge returns CORS headers only to an allowed origin. It also supports the private-network preflight header that browsers use for a public HTTPS page calling a loopback service.

The HTTP server thread parses, authenticates, and queues commands. It never calls Autodesk APIs. A dedicated Fusion custom event drains the queue on Fusion's main thread and calls `Controller.dispatch` with `FusionTools.message_context` as the context capture function.

## Connection controls in Fusion

Click the **Render** status button in STEVE's header, or open **Settings → Render Studio**.
Green means paired, provider ready, and a request from the configured browser origin was
seen within 90 seconds. Amber means pairing or AI sign-in is pending. Red means unpaired,
unavailable, or a paired browser has been inactive for 90 seconds. This activity signal
is not an authenticated heartbeat; the panel shows pairing separately. Background browser
throttling can make an otherwise paired browser appear inactive.

**Copy debug log** copies a bounded connection-only report (latest 100 events), with a
selectable text fallback. It does not include prompts, credentials, signatures, or pairing
secrets. Full opt-in STEVE logging remains under Diagnostics.

The **Render instance address** must be an exact HTTP(S) origin, optionally including a
port, e.g. `http://localhost:5173`. Paths, credentials and wildcard origins are rejected.
Changing it clears the old pairing and secret. Connect and approve again from that Render
instance. The bridge continues listening only on `127.0.0.1:38173`; this setting changes
the permitted browser origin, not the listening address. The selected instance must
implement the STEVE protocol described above.

The address persists in `render-bridge.json` under STEVE's data directory
(`~/Library/Application Support/STEVE` on macOS), as `{"renderOrigin":"https://render3d.app"}`.
Manual file changes are loaded on the next STEVE restart; the settings UI applies them
immediately. Address changes are rejected while an operation is busy or queued.

## Live Design Chat feed (capabilities.chatEvents)

The bridge now exposes **POST `/v1/events`**, authenticated with the same pairing secret
and six-field HMAC format as submissions. Sign `/v1/events` as the path. Native
`EventSource` is not used because it cannot send the required authentication headers.
Poll every 250 ms while watching a request; this is low-latency polling, not a WebSocket.
Do not put secrets in URLs. Ordinary `/v1/status` remains free of chat content.

Body:

```json
{"requestId":"the-original-submission-X-Request-Id","after":0}
```

The header `X-Request-Id` identifies this read attempt (use a fresh UUID); the body
`requestId` identifies the CAD submission. Use a fresh nonce and signature every time.
First read uses `after: 0`. Subsequent reads use the returned `cursor`.

Response:

```json
{
  "version": 1,
  "cursor": 18,
  "reset": false,
  "snapshot": null,
  "events": [
    {"cursor": 17, "requestId": "prompt-123", "type": "status", "phase": "running", "status": "Writing"},
    {"cursor": 18, "requestId": "prompt-123", "type": "message", "message": {"id": "answer-1", "role": "assistant", "text": "I am creating the bracket…"}}
  ]
}
```

Message events **replace/upsert** the text of that message ID. Never append their text
as token deltas. Status events merge into the request's state; fields include `phase`,
`status`, `error`, `waitingForFusion`, `waitingReason`, `targetDocument`, and `activeTools`.
Phases: `queued`, `running`, `completed`, `failed`, `stopped`. Process the entire batch
before treating a terminal phase as finished: the final text can follow its status event.

When `reset` is true, replace the local request state with `snapshot`. This occurs on
first subscribe, after a cursor gap, or an invalid future cursor. Snapshot includes
`messages`, `phase`, status/error, tools and target document. The bridge retains 64
request snapshots and 256 replay events in memory, with the latest 100 transcript
entries (32,000 characters per message). `transcriptTruncated` / message `truncated`
indicate limits. A restart or address change clears this history and pairing. A 404
`request_not_found` means unknown/expired; do not silently resubmit a modeling job.

Only the messages belonging to that Render submission are mirrored, including user
steering during the active response. Unrelated STEVE chats, earlier conversation history,
authentication state, internal reasoning, generated code, raw tool results and image bytes
are not exposed. Tool names/status and user-visible assistant text are included. Common
credential patterns are redacted, but design chat still contains the user's design data.
The copy-debug-log feature remains connection-only.

### Wiring Render Design Chat

A dependency-free browser implementation is in `examples/render-design-chat-client.js`.

1. Keep **STEVE** as an explicit CAD engine. Jake prompts do not go to Fusion.
2. On Send, allocate a stable submission UUID and associate it locally with the Render
   project, Design Chat conversation, and prompt/trace IDs. Autodesk `projectId` is a
   Fusion save destination, not the Render project ID.
3. Reuse the existing pairing secret. Call `submit(uuid, {prompt, designName, ...})`.
   A lost response can be retried with the same UUID and exact payload, never a new ID.
4. Call `watch(uuid, {onUpdate, onConnection, signal})` after HTTP 202 (or an idempotent
   HTTP 200). Put each snapshot into the matching Design Chat conversation. Key messages
   by `(submission UUID, message.id)`. Merge the echoed `prompt` message with the already
   displayed user prompt rather than showing it twice.
5. Show STEVE assistant text as it changes, plus activity rows for tools, waiting on a
   particular Fusion document, errors, and completion. Escape text/Markdown as usual.
   Do not execute tool text or render arbitrary HTML.
6. Keep transcript persistence in Render's existing conversation store. Abort the watcher
   on component teardown; subscribing again recovers a snapshot while retained. Aborting
   the watcher **does not stop Fusion's operation**.
7. On transient network failure show “Reconnecting” and retry with backoff. On 401 require
   pairing again; on 403 check the configured Render origin; on 404 show history expired.
   Never convert those errors into automatic CAD resubmissions. New prompts during a job
   queue as separate requests; this endpoint does not implement remote Stop/steer.

Example (inside Render's existing STEVE submit handler):

```js
import { createSteveChatClient } from './render-design-chat-client.js';
const client = createSteveChatClient({ secret: existingPairingSecret });
const submissionId = crypto.randomUUID();
// Store submissionId -> current Render project/conversation/prompt locally before sending.
await client.submit(submissionId, { prompt: draftText, designName });
await client.watch(submissionId, {
  signal: abortController.signal,
  onUpdate: snapshot => updateDesignChatForSubmission(submissionId, snapshot),
  onConnection: (status, error) => updateBridgeConnectionBadge(status, error?.message),
});
```

The two `update...` functions and secret retrieval in this snippet are integration points,
not existing Render APIs. This repository implements the Fusion side and supplies the
client; Render's deployed UI must wire it into its own Design Chat store/components.
