# Render Studio frontend integration

This directory packages the Render connector used with this fork: pairing, green/red/amber
status, authenticated submissions, live Design Chat replies, and storage RPC (including the native Fusion folder
picker). It is an integration bundle, not the entire Render Studio application.

## Files to deploy

Copy `steve-connector.js`, `steve-chat-feed.js`, `steve-design-chat.js`, `steve-result-open.js`,
`steve-connector.css`, and `steve-setup.css` into Render's `frontend/cad/`.
Load both stylesheets. Also deploy `steve-live-preview.js`, `steve-prompt-text.js`,
`steve-activity.js`, `steve-activity-ui.js`, `steve-activity.css`, `steve-project-binding.js`, and `steve-mark.svg`.
Keep these modules together; the activity UI loads its stylesheet from `/cad/`.
Copy [`examples/render-storage-settings.js`](../../examples/render-storage-settings.js)
to `frontend/cad/steve-storage-settings.js`. That example is the canonical settings source;
there is intentionally no second copy here. Merge `connector-fragment.html` into the CAD
engine picker, keeping the engine button and workflow adjacent. Load the CSS once.
Use the fork's installation link in the fragment, not upstream STEVE releases.
Preserve the rest of the host application and its existing engine selection handlers.

## Background replies and viewport notifications

Mount the background watcher once at application startup, outside engine selection
and Design Chat mounting. STEVE receives live updates only for its locked Render account and project, even
while you view another project. The first history load is quiet. New
completed assistant replies show one bottom-right card with the native STEVE logo.
Streaming chunks update the conversation without producing repeated cards.

```js
import { configureSteveActivity, configureSteveLivePreview }
  from '../cad/steve-design-chat.js?v=20261008-completion-placement1';

configureSteveActivity({
  host: document.getElementById('viewport'),
  getOwner: () => ({
    userId: String(currentUser?.id || ''),
    projectId: String(projectId || ''),
  }),
  projectLabel: id => allProjects?.find(project => String(project.id) === id)?.name || id,
  getProjects: () => allProjects || [],
  openProject: (id, isCurrent) => isCurrent() ? loadProject(id) : Promise.resolve(),
});
configureSteveLivePreview({
  THREE, scene, fit: object => fitCameraToObject(object),
  getOwner: () => ({ userId: String(currentUser?.id || ''), projectId: String(projectId || '') }),
});
```

Use the host's existing project loader, account getters, and Three scene. Keep the
same cache-busted `steve-design-chat.js` URL in every importer so the page shares
one chat store. Continue dispatching `render3d:auth-session` and
`render3d:project-changed` from their existing lifecycle handlers.

**Open chat** opens a read-only request conversation over the viewport without
changing projects. **Open project** is the explicit navigation action; replies use
that project's existing STEVE controls. To prevent overlapping conversation panels,
dispatch `render3d:design-chat-open` when the normal Design Chat opens, and listen
for `render3d:steve-activity-open` to call its existing close function. Closing
must preserve the composer draft. The [host patch](activity-host.patch) shows these
hooks against the deployed Render source; merge the relevant hunks into your host.
It includes existing Render-specific imports that are not part of this portable bundle.

Background activity updates only the locked project's request-scoped chat cache.
It displays the live mesh only when the viewport also shows that project. It does not submit prompts, switch projects, import
saved files, or write background transcripts through a new server endpoint.
Normal Fusion restarts retain approval and reconnect with fresh signed requests.
Clearing browser storage or changing the configured Render address requires pairing
again. Offline Fusion remains unavailable until it is running and reachable.

Deploy `steve-activity-fixture.html` only when you want the isolated verification
page. Its controls use synthetic account/project data and make no modeling requests.
`npm test` exercises restart epochs, ownership, notification deduplication, disposal,
authentication backoff, and live preview polling with no Design Chat host.

## Keep STEVE locked to its project

The native bridge owns one project binding for the paired Render origin. A visible
project change never changes that binding. Render displays the locked project name
and ID, with an explicit action to open it.

After work, preview exports, and saves finish, STEVE becomes available for another
project. An explicit new Send in a different project of the same account claims
it with the last binding revision. Browsing never claims it. The previous
association remains in place until that handoff, so final results stay readable.

Hosts that expose manual project selection can also use **Change project**,
review the old and new IDs, and confirm. STEVE refuses a change while work is active or queued. A confirmation from
a stale browser tab cannot replace a newer selection. Cancel leaves the lock intact.

Before recording or submitting a new request, read the authenticated binding and
check it against the captured composer owner. Include `bindingRevision` with the
submission. If the project differs, block the send and offer to open the locked
project. Do not move the draft or silently send it to the locked project. An older
STEVE server without `projectBinding` support must be updated before submitting.

A binding change clears live notifications, the selected activity conversation, and
preview state. In-flight responses from an earlier binding must not draw a model.
Cached history from another project remains historical and cannot seed live geometry.
Pairing approval and the project lock both persist across normal Fusion restarts.

The [host patch](project-lock-host.patch) records the deployed Render hooks, including
its existing project-list run badges. Those Render-specific history and badge helpers
are host code, not dependencies supplied by this portable bundle. Merge the relevant
hooks and update every importer to the same module version.

The [project binding protocol](../../docs/EXTERNAL_BRIDGE.md#lock-steve-to-one-render-project)
defines the signed reads, explicit compare-and-set change, and submission fields.

## Connect the composer

In `frontend/studio/app.js`, keep one integration promise for the page lifetime:

```js
let steveIntegrationPromise;
function getSteveIntegration() {
  return steveIntegrationPromise ||= import('../cad/steve-design-chat.js?v=20261008-completion-placement1')
    .then(mod => mod.mountSteveDesignChat({
      getPrompt: () => composer?.getPromptText?.() || '',
      getFusionStatus: () => api('/api/autodesk/status'),
      connectFusion: () => document.getElementById('btn-fusion-connect')?.click(),
      setPromptStatus: (tone, message) => {
        // Use the host application's existing composer status renderer.
        showComposerStatus(tone, message);
      },
      connectorOptions: {
        onChange(snapshot) {
          // Update the host's selected-engine indicator from snapshot.state.
          updateSteveEngineIndicator(snapshot);
        },
      },
    }));
}
```

`showComposerStatus` and `updateSteveEngineIndicator` above are host adapter placeholders.
Supply `getFusionStatus` and `connectFusion` from the existing Autodesk integration;
the setup dialog requires a linked Fusion account. The host also handles the existing
`render3d:attach-cad-library` and `render3d:open-fusion-library` events to open its Fusion
library/project-home UI. Retain the host's modal base styles (`auth-modal`, `auth-card`,
`auth-backdrop`, and `hidden`) along with the bundled setup CSS.
In the current Render implementation these map to the prompt status renderer and
`steveConnectionState = snapshot.state; syncPromptActiveEngineIndicator()`.
Set `integration.setActive(true)` while the CAD picker is open or STEVE is the selected
workflow; set it false when both close. Set the engine button's `aria-pressed` when
selecting STEVE. Route the composer send action to `integration.submitCurrent({ owner, prompt })` only
when STEVE is selected; surface rejected promises through the composer error UI.
Do not route Jake/other engines through this method.

Do not automatically pass `currentContext.projectId/folderId` with every submission:
that overrides the saved autosave destination. Explicit destination overrides are still
supported by `connector.submit({prompt, designName, projectId, folderId})`.

## Mount Preferences → CAD & files

After `mountPreferencesShell(panel, ...)` creates the advanced CAD panel:

```js
const fusionSettings = panel.querySelector('[data-preferences-advanced-panel="cad"]');
if (fusionSettings) {
  const root = document.createElement('section');
  fusionSettings.prepend(root);
  root.textContent = 'Loading Fusion autosave settings…';
  void Promise.all([
    getSteveIntegration(),
    import('../cad/steve-storage-settings.js?v=steve-storage-1'),
  ]).then(([integration, mod]) => {
    if (!root.isConnected) return;
    const cleanup = mod.mountSteveStorageSettings(root, integration.connector, {
      fusionIntegration: {
        getStatus: () => api('/api/autodesk/status'),
        connect: () => {
          const button = document.getElementById('btn-fusion-connect');
          if (!button) throw new Error('Open Account → Fusion to connect your Autodesk account.');
          button.click();
        },
      },
    });
    // Register cleanup with the host's preferences-close/unmount lifecycle.
  }).catch(error => {
    if (root.isConnected) root.textContent = error.message || 'Could not load Fusion settings.';
  });
}
```

`api`, the status endpoint, and the connect button are existing Render integration hooks;
this package does not supply a new OAuth backend. Other hosts can supply equivalent
callbacks or omit `fusionIntegration`. Render's Autodesk account link and local STEVE
pairing are separate. The native dialog uses the account signed into desktop Fusion.

Increment module query versions and the host app script version when deploying to bypass
cached modules. Allow the browser's local-network access prompt when connecting.
Do not expose the loopback bridge through a public proxy or put pairing secrets in URLs.
The connector stores the paired secret in its existing IndexedDB store.

## Folder and save behavior

Choose folder in Fusion opens Fusion's supported cloud-folder dialog when advertised by
`getSettings.nativeFolderPicker`. The connector allows ten minutes for the modal request;
retries retain the operation ID to avoid duplicate dialogs. Cancellation leaves preferences
unchanged. Selection previews a destination; **Use this folder** persists it. The dropdown
browser remains available when the native API is unavailable.

Autosave runs after a successful Render job and waits for Fusion/cloud completion. Existing
saved documents save in place; the configured destination applies to new unsaved documents.
The target document stays pinned to the request. Autodesk's editable-file limit still needs
the user's manual Read-only toggle; this integration does not silently change file access.

## Live Design Chat

The Design Chat wrapper persists a request ID **before** submission, then watches the
signed `/v1/events` feed through the existing paired connector. Tool activity, assistant
text, waiting states, and failures update the same request instead of creating duplicate
messages. Network reconnects never resubmit a modeling request.

Capture the owner and prompt before awaiting anything in the STEVE send branch:

```js
const owner = { userId: String(currentUser.id), projectId: String(projectId) };
const prompt = composer.getPromptText();
const integration = await getSteveIntegration();
await integration.setActive(true);
await integration.submitCurrent({ owner, prompt });
```

In Render's `frontend/components/render-agent.js` (the Design Chat host), import:

```js
import { steveDesignChat, mountSteveReplyRecovery }
  from '../cad/steve-design-chat.js?v=20261008-completion-placement1';
const steveChatOwner = () => ({
  userId: String(currentUserId() || ''),
  projectId: String(getProjectId() || ''),
});
```

Use the host's existing account/project getters. Merge
`...steveDesignChat.messages(steveChatOwner())` into both the displayed message list and
conversation context. Keep the existing escaped/Markdown message renderer; label messages
with `message.steve` as STEVE. On chat open/project change, call
`void steveDesignChat.resume(steveChatOwner())`.
After mounting the conversation host:

```js
mountSteveReplyRecovery({ host, getOwner: steveChatOwner });
window.addEventListener('render3d:steve-chat-updated', event => {
  const owner = steveChatOwner();
  if (event.detail.userId === owner.userId && event.detail.projectId === owner.projectId) {
    renderDesignChat(host);
  }
});
```

Register this listener once per host and remove it if the host is unmounted. The recovery
control uses `.prompt-design-header > div:first-child`; preserve that header slot in the
host template. Its **Recover STEVE reply** action accepts a known bridge request ID and
reads the retained feed without running the design again.

Transcripts are stored in this browser's localStorage, scoped by account, project, and
request. This is **not server-synced conversation history**. Completed history is bounded
to 50 requests per account/project. Clearing site data removes it; unavailable/full storage
shows a warning. Pairing secrets remain in IndexedDB and are not copied into chat records.
Older replies can be recovered while the STEVE bridge retains them, including its
bounded history restored after a normal restart.
This watches Render-submitted requests; it does not mirror unrelated Fusion-only chats.

Increment the host app and module query versions on deployment. A green connection badge
alone does not verify chat rendering: the wrapper **and** host rendering hooks are required.
See also the [protocol guide](../../docs/EXTERNAL_BRIDGE.md#live-design-chat-feed-capabilitieschatevents).

## Saved design opening

The legacy per-request watcher supports automatic saved-file opening as described
below. With the background activity watcher enabled, completion is shown through
live geometry and a notification instead; saved files remain available through the
existing result action and Fusion library. Background discovery does not auto-import.

New requests submitted through `mountSteveDesignChat` record an automatic-open intent.
After Fusion confirms the save, `steve-result-open.js` resolves the exact saved Autodesk
project through the linked account's hubs and calls the existing `/api/autodesk/import`
endpoint with the saved file/folder IDs and the **originating Render project** as its target.
It opens the returned displayable filename in that project's viewport.

The [minimal host patch](auto-open-host.patch) shows the app and chat changes against
the previous deployed chat integration. Review/apply it against your current host source;
it includes the viewer's final account/project guard. Copy the modules above as well,
and update the host HTML script version to bypass cached code.

Configure this once in the host application:

```js
import { configureSteveResultOpening }
  from '../cad/steve-design-chat.js?v=20261008-completion-placement1';
configureSteveResultOpening({
  api,
  getOwner: () => ({
    userId: String(currentUser?.id || ''),
    projectId: String(projectId || ''),
  }),
  openFile: async (result, isCurrent) => {
    if (!isCurrent()) return false;
    await refreshFiles();
    if (!isCurrent()) return false;
    return loadModel(projectFileUrl(result.project_id, result.filename), result.filename, {
      projectId: result.project_id, catalogFilename: result.filename, label: result.name,
      append: true, cacheBust: true, fitView: true, isCurrent,
    });
  },
});
```

These are Render's existing API/viewer adapters. An equivalent host loader **must honor**
`isCurrent` before changing the scene, including after asynchronous downloads/conversion.
The current Render `loadModel` implements this guard. Importing requires the existing
Autodesk account integration; pairing with the local STEVE bridge alone is insufficient.

In the Design Chat renderer, request
`steveDesignChat.messages(owner, { includeResults: true })`. Import
`mountSteveSavedResult` from the same module and call
`mountSteveSavedResult(row, message, owner)` after rendering a result row. Keep result
controls out of the AI conversation context by leaving `includeResults` false there.

Auto-open runs only for new submitted requests with a confirmed saved location. Recovered
historical replies do not auto-import. Switching account/project defers opening to an
explicit **Open saved design in Render** action in the original project. Missing metadata
shows **Open Fusion library** and **Check save status** instead. Autosave must be enabled
for deterministic saved-file metadata; old `unchanged` results that lack project/folder
metadata also use the library fallback.

A browser Web Lock coordinates each request across tabs, and an import claim is persisted
before sending the import. Refreshing or repeated completion events do not duplicate the
import. If the import response is lost, the UI directs the user to check project files or
the Fusion library instead of silently repeating it. Successful imports can be reopened
without importing again. This adds the result alongside the existing viewport models.

## Verification

From the repository root:

```sh
node --test integrations/render-studio/*.test.js
node tests/test_render_storage_settings.mjs
node tests/test_render_chat_client.cjs
```

Connector tests use fake network responses and verify status, pairing, exact signed payloads,
route-specific storage signing, polling, and error handling. The HTML test checks the portable
fragment. These tests do not establish an end-to-end modeling/cloud-save result. Live Fusion
folder selection was observed during development; the subsequent extended timeout change
was not rechecked with a second live modal selection. Render's broader verification had
unrelated failures; this package does not claim the entire host application passes.

Live verification: an existing completed STEVE reply and its tool activity were recovered
into the original Render project without resubmission, and remained after browser refresh.
The packaged targeted tests pass; broader Render checks still have failures/timeouts, so
this is not a claim that all host application checks pass.

## Live mesh and automatic project chat recovery

Copy the updated connector, chat wrapper/feed, result opener, and the new
`steve-prompt-text.js` and `steve-live-preview.js` modules into Render's `frontend/cad`.
Their adjacent tests are standalone Node tests. `live-preview-host.patch` records the
minimal host changes against the deployed Render version; review it and merge the
relevant hunks when your host differs. Preserve existing host imports, history-sync
hooks and setup controls. Do not replace whole host files.

Use one identical `steve-design-chat.js?v=20261008-steve-auth-ping1` import URL in the
application's static import, dynamic STEVE loader and Design Chat renderer. Bump the
outer app/render-agent script URLs too so browsers load the new dependencies.

```js
import { configureSteveLivePreview }
  from '../cad/steve-design-chat.js?v=20261008-steve-auth-ping1';
import { serializeStevePrompt }
  from '../cad/steve-prompt-text.js?v=20261008-steve-integration3';

configureSteveLivePreview({
  THREE, scene,
  fit: object => fitCameraToObject(object),
  getOwner: () => ({ userId: String(currentUser?.id || ''), projectId: String(projectId || '') }),
});

// In the STEVE submit branch, capture context before awaiting the connector.
const owner = { userId: String(currentUser?.id || ''), projectId: String(projectId || '') };
const stevePrompt = serializeStevePrompt({
  prompt, references: preparedReferences || composer.getReferences(),
  images: preparedImages || promptImages || [], origin: window.location.origin,
});
const integration = await getSteveIntegration();
await integration.setActive(true);
await integration.submitCurrent({ owner, prompt: stevePrompt });
```

`mountSteveReplyRecovery({host, getOwner})` now automatically requests the latest
owner/project-scoped chat when the panel opens and every three seconds while visible.
The native bridge must advertise `projectChatHistory`. It validates returned owner
metadata and restores completed-chat followups without sending a modeling prompt or
importing an old saved file. Request-ID recovery remains as a fallback. Existing
remote server prompt-history synchronization is independent; this portable bundle
requires no new backend endpoint for live chat or mesh delivery.

The preview uses Render's existing Three scene and a separate transient group. It
updates every two seconds while the browser page is visible, including when Design Chat
is closed. It replaces the previous
mesh, disposes old GPU resources, and fits the camera only on the first nonempty frame.
Positions are millimetres and Z-up. Switching account/project clears the preview.
Errors retain the last good geometry and show a status message. Restarted bridges can
return `reset:true` with a lower revision and a full validated snapshot.

Pairing is browser-local in IndexedDB, and STEVE retains the approved key in an
origin-bound `render-pairing.json` file with owner-only permissions. Normal Fusion
restarts restore that pairing. Changing the Render address revokes it. Pre-restart
signed requests are rejected; clients can retry with a fresh timestamp.

If browser storage was cleared, use the normal STEVE setup UI and approve in Fusion
once. An explicit replacement pairing preserves the previous key until approval
completes; denial retains the existing connection. Never paste a pairing secret into
logs or scripts. STEVE now opens its panel automatically when the add-in starts;
enable **Run on Startup** for the active installation in Fusion.
A paired Fusion server does not prove this browser has its matching key. Refresh after
installing the new scripts. Cloud Autodesk integration is still used for the saved-file
library/import; the live mesh itself comes directly from the local Fusion bridge.

Reference serialization sends plain URLs and available text, not Render-only reference
chips. Local/protected images are identified as needing a direct attachment. It does
not transfer image pixels into STEVE or create a Fusion canvas. See the bridge guide
for provider-specific web access limitations.

Connection polling uses signed `POST /v1/ping` when `capabilities.authPing` is true.
This validates the stored key without submitting modeling work. Transient authentication
errors retain the key and retry with backoff; tabs adopt a newly approved key from
IndexedDB automatically. No modeling submissions are automatically replayed.

Verification for the background activity update: 44 native bridge/feed tests and
5 preview tests passed, along with 74 portable frontend tests. Production browser checks confirmed a real reply notification,
its viewport conversation, and new Fusion geometry without another refresh while
Design Chat was closed. Two zero-face Fusion bodies had blocked tessellation; the
exporter now excludes bodies with no faces and keeps exporting valid geometry.
The wider Render checks had 99 passes and 8 failures, including failures reproduced
on pre-edit sources. Its deployment receipt remains unverified; these results do
not claim the full Render application passes every check.

## Place STEVE assemblies beside existing models

`configureSteveLivePreview` accepts a `place(root, packet)` host callback. Place the
whole Z-up millimetre assembly on the floor and beside occupied project bounds.
Return a cleanup function if the host temporarily hides an exact matching saved
result. The layer restores that visibility before replacing or clearing a preview.
Each refresh starts from the unshifted root, so translations do not accumulate.

The Render host wiring is in `placement-host.patch`. It reuses
`seatObjectToFloor` and `placeNewestAssemblyObjectInGrid`. Saved imports enable
`autoGridPlace` and `seatNewObject`, and disable whole-assembly seating. Existing
objects keep their transforms. After a saved import finishes, call the returned
preview controller's `refreshPlacement()` to reconcile the matching catalog object
without waiting for another geometry revision.
