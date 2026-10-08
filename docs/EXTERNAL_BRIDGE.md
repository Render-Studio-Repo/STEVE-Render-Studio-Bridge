# Render Studio bridge protocol

The external bridge lets Render Studio submit a prompt to STEVE after the user approves a local pairing request. STEVE starts the bridge with its Fusion add-in and stops it when the add-in stops.

The bridge listens only on `127.0.0.1:38173`. It accepts browser requests from the exact Render origin configured in STEVE, defaulting to `https://render3d.app`. Tests and development tools can inject other exact origins when they construct `ExternalBridge`. See [installation with an AI assistant](INSTALL_WITH_AI.md) for first-time setup.

## Check the connection

Send `GET /v1/status` with the `Origin` header. The response reports protocol version `1`, the connection phase, Fusion and provider readiness, current busy state, the command queue depth, and supported capabilities. `ready` becomes true only after pairing while STEVE's selected provider is signed in and connected. The response never returns a pairing secret or a prompt.

The connection phases are `unpaired`, `pairing_pending`, `pairing_approved`, `paired`, `pairing_denied`, and `stopped`.

The default destination for new documents is the current Fusion Data Panel project and folder unless the user has saved a default folder through the storage API. Existing documents save in place. A client may provide an existing Autodesk project and folder ID from an optional browser. With autosave enabled, the bridge resolves an explicit destination through the signed-in Fusion Data API before dispatch and rejects inaccessible folders. With autosave off, save instructions remain model guidance. STEVE does not create Autodesk project folders in version 1. Check `capabilities.createFolder` before offering that action.

## Pair Render Studio

1. Send `POST /v1/pairing/request` with `{}`.
2. Show the returned `pairingId` to the user.
3. Ask the user to approve the same request in STEVE. The STEVE panel calls `externalBridgeApprove` or `externalBridgeDeny` with the `pairingId`.
4. Poll `POST /v1/pairing/complete` with `{"pairingId":"..."}`.
5. Store the returned secret in browser storage that is unavailable to ordinary page scripts when possible. Do not use `localStorage`.

The completion endpoint returns the secret once. STEVE saves the approved key in an origin-bound, owner-only `render-pairing.json` file and restores it after normal restarts. Render keeps its matching key in IndexedDB. Changing the Render address revokes the saved pairing; clearing browser storage requires a new approval. Signed `POST /v1/ping` with `{}` verifies the key without submitting modeling work when `capabilities.authPing` is true.

## Lock STEVE to one Render project

Pairing permits a Render origin to authenticate. A separate project binding selects
one Render account and project for that paired bridge. `capabilities.projectBinding`
advertises this contract. Switching browser tabs, changing the visible Render project,
or rotating the pairing key does not change the binding.

The first explicit Send associates an unbound bridge with that Render project using a null expected revision. Navigation does not associate or move it. Render does not need a project-lock dropdown.

Targeted replies include `replyToRequestId` in the signed submission and require the native `replyToRequest` capability. The bridge resolves the earlier request's provider and native conversation under the original project ownership. Replies may queue while STEVE is busy. Dispatch rejects a different active conversation rather than sending there. Each reply retains its own idempotency request ID.

Signed `POST /v1/project` with `{"action":"get"}` returns
`{version:1,binding:null}` or a binding containing `renderUserId`, `renderProjectId`,
and `revision`. Render displays the bound project name and ID even when the user
views another project.

The project and activity packets also report `busy` and `availableForProjectChange`.
Availability becomes true after the latest bound request completes successfully,
with no queued work, active tools, pending message deliveries, preview exports,
or save operations. Preview completion means the export is ready in the bridge
cache; it is not a browser delivery acknowledgment. A failed or stopped request is not advertised as finished.
The final binding remains intact so its chat and model can still arrive. After availability is confirmed, an explicit new Send in another project of the
same account may claim the bridge using the current revision. The server checks
for new busy work again before accepting that handoff. Automatic handoffs include
`requireAvailable: true`; the server atomically rechecks completion and returns
`409 project_not_finished` if the request is no longer finished. Browsing alone never
transfers it; requests already carrying a revision cannot silently reclaim it. Treat missing availability metadata as unavailable.

An explicit project-selection confirmation sends:

```json
{
  "action": "bind",
  "renderUserId": "Render account ID",
  "renderProjectId": "Render project ID",
  "expectedRevision": null
}
```

`expectedRevision:null` selects a project only while unbound. To change an existing
binding, supply its current revision. A stale revision fails instead of overwriting
another tab's selection. A same-project request with the matching revision is a no-op.
Binding changes are blocked while STEVE has active, queued, dispatched, or saving work.
The client must not retry a rejected change with a fresh revision without renewed
user intent.

The origin-bound `render-project.json` file persists the binding across restarts.
Malformed saved state fails closed. First-time migration can retain an existing
association only when all retained owned requests identify one account/project pair.
Changing the configured Render origin revokes that association.

Submissions require the bound account, project, and `bindingRevision`. Requests,
model previews, and background activity must also belong to the binding. Retained
history is not reassigned when a user changes the lock. The Autodesk save destination
uses separate `projectId` and `folderId` fields and does not select the Render project.

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
  "renderUserId": "bound Render account ID",
  "renderProjectId": "bound Render project ID",
  "bindingRevision": "current binding revision",
  "projectId": "optional Autodesk project ID",
  "folderId": "optional Autodesk folder ID",
  "designName": "optional design name"
}
```

The prompt limit is 32,000 characters. The complete body limit is 65,536 bytes. STEVE holds at most 16 accepted commands while Fusion is busy.

STEVE frames the destination and requested name before sending the request through its existing controller. With autosave enabled, saving is owned by the bridge rather than the model; see the autosave section below for destination precedence and existing-document behavior. With autosave disabled, these fields are instructions to the model and are not a deterministic save guarantee.

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


## Web links and image references

The bridge accepts a plain-text `prompt`. Preserve literal public URLs in that text;
Render-only linked-item tokens (for example `@amazon-…`) are not URLs and cannot be
resolved by STEVE unless Render expands them from its reference metadata. Label each
reference and include its real source URL, image URL when available, and relevant
known product details. Do not fabricate a source URL from an opaque item ID.

A Render canvas, selected object, or uploaded image is not automatically transferred
into the Fusion document. Passing an image URL supplies a text reference, not image
pixels. Protected Render endpoints, local/blob URLs, and login-only pages may be
unavailable to the model. Attach the image directly in STEVE when visual inspection
is required and a public image cannot be read. Never put session cookies or API
credentials in the prompt to make a private link work.

In this fork, the ChatGPT transport enables live web search. The Grok transport also
passes web-search tools through its provider gateway. Provider availability and page
access still apply; this is not a guarantee that every URL or image can be opened.
The Claude, OpenRouter, and custom OpenAI-compatible transports disable web search.
All providers have `fusion_fetch_docs`, but it reads only the allowlisted Autodesk
Fusion API HTML pages—it cannot read an arbitrary product listing or motor PDF.
STEVE's own image attachment flow can supply pixels to image-capable models; the
current Render bridge submission does not carry binary image attachments.

The handoff instructions distinguish external references from Fusion canvases and
require STEVE to identify inaccessible references instead of treating an empty Fusion
document as proof that Render supplied no context. Those bridge-side instructions
load on the next STEVE start; updating source alone does not restart an active chat.

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
Phases: `queued`, `running`, `saving`, `completed`, `failed`, `stopped`. Process the entire batch
before treating a terminal phase as finished: the final text can follow its status event.

When `reset` is true, replace the local request state with `snapshot`. This occurs on
first subscribe, after a cursor gap, or an invalid future cursor. Snapshot includes
`messages`, `phase`, status/error, tools and target document. The bridge retains 64
request snapshots and 256 replay events in memory, with a 7.5 MB aggregate transcript
budget and 32,000 characters per message. `transcriptTruncated` / message `truncated`
indicate limits. Bounded public history persists across normal restarts; interrupted jobs restore as stopped. Changing the configured address clears the association. A 404
`request_not_found` means unknown/expired; do not silently resubmit a modeling job.

Only the messages belonging to that Render submission are mirrored, including user
steering during the active response. Unrelated STEVE chats, earlier conversation history,
authentication state, internal reasoning, generated code, raw tool results and image bytes
are not exposed. Tool names/status and user-visible assistant text are included. Common
credential patterns are redacted, but design chat still contains the user's design data.
The copy-debug-log feature remains connection-only.

### Background activity for the locked project (capabilities.activityFeed)

Signed `POST /v1/activity` accepts exactly
`{"renderUserId":"<current Render account>","after":0}`. It returns
`{version:1,cursor,epoch,reset,requests,binding,busy,availableForProjectChange}`. Each entry in `requests` is a full public
request snapshot with its original `requestId`, `renderUserId`, `renderProjectId`,
and messages. Results are filtered to the bound account and project. Unbound or
other-account activity returns no requests; unowned legacy requests are excluded. This is a read-only endpoint and never starts modeling work.

Start with `after:0`, then send the returned cursor to receive changed requests.
A cursor gap returns a full reset. Compare `epoch` on every response and fetch
`after:0` if it changes: a restarted bridge can reach an old numeric cursor before
the browser polls again. The epoch also includes the binding revision. Clear live
records, notifications, and previews immediately when that binding changes. Retention is bounded to 64 requests and a 7.5 MB aggregate
transcript budget. A truncated snapshot reports `transcriptTruncated`.

Mount one binding-aware activity watcher at application startup, independently of
the selected CAD engine or whether Design Chat is open. Use the initial snapshot
as a quiet baseline, upsert subsequent snapshots by request ID, and deduplicate
notifications by request/message identity. Reset account state on sign-out/account
changes. Use the existing authentication retry policy; never replay submissions.

Show completed assistant replies in a bottom-right STEVE notification. Opening its
conversation should retain the active viewport project; a separate **Open project**
action may explicitly navigate. Only apply live meshes when both the account and
originating project match the active viewport, checking again after awaited work.

### Wiring Render Design Chat

A dependency-free browser implementation is in `examples/render-design-chat-client.js`.

1. Keep **STEVE** as an explicit CAD engine. Jake prompts do not go to Fusion.
2. On Send, capture the composer owner and read the authenticated project binding.
   Reject a different owner before recording a pending message. Then allocate a stable
   submission UUID and associate it locally with the Render project, Design Chat
   conversation, and prompt/trace IDs. Autodesk `projectId` is a Fusion save destination,
   not the Render project ID.
3. Reuse the existing pairing secret. Call `submit(uuid, {prompt, designName,
   renderUserId, renderProjectId, bindingRevision, ...})` with the checked binding.
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
7. On transient network or authentication failure show “Reconnecting” and retry with
   backoff while retaining the saved key. Re-read IndexedDB to adopt a key approved in
   another tab. If a signature mismatch persists, offer the explicit pairing flow; on
   403 check the configured Render origin; on 404 show history expired.
   Never convert those errors into automatic CAD resubmissions. New prompts during a job
   queue as separate requests; this endpoint does not implement remote Stop/steer.

Example (inside Render's existing STEVE submit handler):

```js
import { createSteveChatClient } from './render-design-chat-client.js';
const client = createSteveChatClient({ secret: existingPairingSecret });
const submissionId = crypto.randomUUID();
// Store submissionId -> current Render project/conversation/prompt locally before sending.
const { binding } = await client.project({ action: 'get' });
if (!binding || binding.renderUserId !== currentUserId || binding.renderProjectId !== currentProjectId) {
  throw new Error('Open the locked project or explicitly change the STEVE project lock first.');
}
await client.submit(submissionId, {
  prompt: draftText, designName,
  renderUserId: binding.renderUserId,
  renderProjectId: binding.renderProjectId,
  bindingRevision: binding.revision,
});
await client.watch(submissionId, {
  signal: abortController.signal,
  onUpdate: snapshot => updateDesignChatForSubmission(submissionId, snapshot),
  onConnection: (status, error) => updateBridgeConnectionBadge(status, error?.message),
});
```

The two `update...` functions and secret retrieval in this snippet are integration points,
not existing Render APIs. This repository implements the Fusion side and supplies the
client; Render's deployed UI must wire it into its own Design Chat store/components.

## Autosave and Render Settings folder picker

With `capabilities.autoSave` and `capabilities.storageSettings`, STEVE autosaves the
**pinned document after each successful Render response**, not on every token or at a
fixed interval during modeling. Autosave is on by default; users can disable it. New
unsaved documents use `saveAs` in a folder resolved and pinned when processing starts.
Per-submission Autodesk project/folder IDs override the default setting. Otherwise the
saved destination is used, or the then-current Data Panel folder if none is configured.
Invalid explicit destinations fail before generation rather than falling back elsewhere.
Existing saved documents get a new version **in their existing folder**; the setting
never silently moves an existing design or creates a duplicate. Failed/stopped modeling
responses do not trigger autosave. No new document is created by autosave itself.

The model is instructed to leave saving to the bridge. If it saves a new document in a
folder other than the pinned destination, autosave reports that mismatch; it does not move
the file. The bridge waits for the target document and an idle Fusion command before
saving and for `DataFile.isComplete` before reporting a confirmed cloud save. Uploads
unconfirmed after 180 seconds report failure and leave the document intact. A failed save
can be retried without rerunning the modeling prompt.

### Storage endpoints

All operations use the pairing secret and ordinary HMAC request headers. All Autodesk
calls execute on Fusion's main thread; HTTP workers only queue requests.

`POST /v1/storage` accepts these bodies:

```json
{"action":"getSettings"}
{"action":"projects"}
{"action":"folders","projectId":"autodesk-project-id","folderId":null}
{"action":"folders","projectId":"autodesk-project-id","folderId":"autodesk-folder-id"}
{"action":"setSettings","autoSave":true,"projectId":"autodesk-project-id","folderId":"autodesk-folder-id"}
{"action":"setSettings","autoSave":true,"projectId":null,"folderId":null}
{"action":"retrySave","requestId":"original-CAD-submission-id"}
```

`projects` lists projects in Fusion's **active hub**. Change hubs in Fusion if needed.
`folders` returns the selected folder/project and its immediate child folders; a null
folder selects the project root. This is a picker for existing folders; creation of new
folders is not implemented (`createFolder: false`). Null project and folder settings mean
“current Data Panel folder at request start.” Settings persist in `render-storage.json`
in STEVE's data directory and apply to subsequent requests, without changing the pairing.
They are shared by the paired browser's users of this local STEVE installation.

A storage operation returns HTTP 202 with `{"requestId":"...","pending":true}`.
Poll signed `POST /v1/storage/result` with `{"requestId":"..."}` until `pending:false`.
The completed envelope contains `result` or `error`. Use a stable header `X-Request-Id`
for retries of the SAME original storage operation. Result polls use fresh header IDs
and nonces. Identical operation retries are idempotent during the in-memory retention
window; changing the body under an existing ID is rejected. Keep the operation ID on
network errors and avoid blindly creating another operation when an outcome is unknown.

The supplied client handles this with `client.storage(payload, {requestId, signal})`.
Mount the supplied folder settings component inside Render's own Settings page:

```js
import { createSteveChatClient } from './render-design-chat-client.js';
import { mountSteveStorageSettings } from './render-storage-settings.js';
const client = createSteveChatClient({secret: existingPairingSecret});
await mountSteveStorageSettings(fusionSettingsContainer, client);
```

`fusionSettingsContainer` and secret retrieval are Render application integration points.
The component supplies the autosave toggle, project picker, child-folder navigation, and
save/default-location buttons. It does not deploy or modify Render's website by itself.

### Design Chat save state and Personal Use limit

Keep watching while phase is `saving`. The request's `save` object reports `pending`,
`waiting`, `blocked`, `uploading`, `saved`, `unchanged`, or `failed`. Show it beneath the
assistant response rather than claiming the file is saved when modeling first finishes.
Confirmed saves include file/project/folder IDs and names. Save failure sets phase `failed`;
show a “Retry save” control that calls `retrySave` and restarts the request watcher.

For a result-opening integration, use `snapshot.save.file.id` only after phase
`completed` and save state `saved` (or `unchanged` for an existing saved document).
This is an Autodesk Fusion DataFile ID, **not a Render project ID**. Resolve it through
Render's Autodesk integration before opening/importing it. Never infer the output from
the active Fusion document or current Data Panel folder, which may have changed.
A `targetDocument.id` alone is not proof of a completed cloud save. If autosave is disabled,
a successful chat response may not include a saved file that Render can open.

When the Personal Use editable count reaches its maximum (usually 10), new-document
saving reports `save.state: blocked`, `save.code: editable_limit`, the actual count/maximum,
and `oldestEligible` when available. “Oldest” means least recently modified among editable
files that are not open in this Fusion session and not reported in use by another user.
Render should name that file and instruct the user to switch it to **Read-only** in Fusion's
My Editable Documents. The bridge retries every five seconds after that manual action.
For a read-only target, show the instruction to make the target editable.

**Automatic read-only switching is not implemented.** Autodesk's public API exposes
[`DataFile.isReadOnly`](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/core_DataFile_isReadOnly.htm)
as a read-only property. [`PersonalUseLimits`](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/core_PersonalUseLimits.htm)
provides the count and editable-file list but no supported method to demote a file.
`capabilities.autoReadOnly` and `limits.canAutoMakeReadOnly` therefore remain false.
Do not display an automatic-rotation toggle or bypass the license limit. No files are
deleted, closed, or silently moved by this feature.

### Render Studio settings integration

The deployed Render Studio integration exposes these controls under **Account →
Preferences → CAD & files → Fusion autosave**. It reuses the CAD engine connector's
IndexedDB pairing and signs each storage endpoint with its own canonical path.
Projects and subfolders come from the running local Fusion session. Browsing alone
never changes the destination: select **Use this folder** to persist it, or **Use
current Fusion Data Panel folder** to restore the default. The autosave checkbox
persists immediately. Existing documents continue saving in place.

Render's `submitCurrent` must omit project/folder IDs unless the user deliberately
provides an override. Sending the current Data Panel IDs on every request would
silently override the saved settings. The storage UI distinguishes the folder being
browsed from the actual saved destination, and shows the editable document count.

### Native Fusion folder picker

`getSettings.nativeFolderPicker` indicates whether the installed Fusion supports
`UserInterface.createCloudFolderDialog`. When available, show **Choose folder in
Fusion…** and send authenticated `{"action":"chooseFolder"}` through `/v1/storage`.
This opens Autodesk's own cloud-folder window on Fusion's main thread. Poll the
operation result as usual, allowing up to ten minutes for user interaction.
Cancellation returns `{"cancelled":true}`; selection returns `cancelled:false` plus
`project` and `folder` objects containing IDs/names. Selection alone changes no
settings or documents. Display it, then call `setSettings` when the user selects
**Use this folder**. Never substitute a local filesystem folder dialog.

The bridge refuses the picker while a STEVE task/save or modeling command is active,
and blocks queue re-entry while the modal dialog is open. Older Fusion versions
continue to use the dropdown browser. Render also displays `/api/autodesk/status`
and offers its existing **Connect Fusion integration** flow when unlinked. Cloud
account linking and local STEVE pairing are separate: the native picker uses the
account signed into the running Fusion application.

## Durable Render chat association

Submissions require `renderProjectId`, `renderUserId`, and `bindingRevision`. The IDs refer to
Render's project and authenticated user, not the Autodesk `projectId`/`folderId`.
On bridges advertising `projectChatHistory`, signed `POST /v1/events` accepts either
`{requestId, after}` or `{renderProjectId, renderUserId, after: 0}`. The latter returns
the most recent matching request as a full reset snapshot, including its STEVE
`threadId`. Render must validate returned scope before displaying or persisting it.
Polling the latest association while the chat is visible also recovers local STEVE
followups in the same bound conversation. Restoring history must not auto-import an
old saved file or resubmit the prompt.

Up to 64 public request histories are retained locally in `render-chat-history.json`
with mode 0600 and a bounded size. No account tokens or hidden reasoning are included.
Running records restored after restart become stopped until their conversation is
reopened. A different conversation never inherits an earlier project's association.
Changing the configured Render origin clears these histories. Legacy requests without
Render scope cannot bypass the binding through request-ID recovery. They cannot be
guessed into a project automatically.

## Live Fusion viewport preview

When `capabilities.livePreview` is true, Render can poll authenticated
`POST /v1/preview` with `{requestId, afterRevision: 0}` about every two seconds.
It queues a read-only snapshot on Fusion's main thread; HTTP threads never access the
Fusion API. Only the matching active STEVE conversation's pinned document is eligible.
A pending response is HTTP 202. Completed snapshots contain `requestId`, `revision`,
`pending: false`, `units: "mm"`, `upAxis: "Z"`, `documentName`, and `bodies`:

```json
{"id":"stable-body-id","name":"Base","positions":[0,0,0,10,0,0,0,10,0],"indices":[0,1,2],"color":[0.65,0.7,0.75]}
```

When `afterRevision` matches, `unchanged: true` replaces the bodies array. If the
client cursor exceeds a restarted bridge’s revision, `reset: true` accompanies a full
snapshot so the client can resume at the lower revision. An `error`
is explicit and must not erase the last valid geometry. An empty `bodies` array is
a valid changed snapshot and removes the old preview. The renderer must check its
current Render account/project/request before every scene update, replace the previous
preview rather than append copies, and preserve the camera after initial framing.

This is a tessellated preview of visible B-Rep bodies, including occurrence placements;
it is not an editable CAD import, sketch/canvas transfer, material reproduction, or a
cloud save. The bridge caches body revisions, exports at most every two seconds, and
limits snapshots to 256 bodies, 150,000 triangles, and 8 MB. Fusion must finish its
current main-thread operation before a preview can update. Saved-design imports remain
available separately for persistent project files.
