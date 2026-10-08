# Render Studio frontend integration

This directory packages the Render connector used with this fork: pairing, green/red/amber
status, authenticated submissions, live Design Chat replies, and storage RPC (including the native Fusion folder
picker). It is an integration bundle, not the entire Render Studio application.

## Files to deploy

Copy `steve-connector.js`, `steve-chat-feed.js`, `steve-design-chat.js`, `steve-result-open.js`,
`steve-connector.css`, and `steve-setup.css` into Render's `frontend/cad/`.
Load both stylesheets. Keep these JavaScript modules together.
Copy [`examples/render-storage-settings.js`](../../examples/render-storage-settings.js)
to `frontend/cad/steve-storage-settings.js`. That example is the canonical settings source;
there is intentionally no second copy here. Merge `connector-fragment.html` into the CAD
engine picker, keeping the engine button and workflow adjacent. Load the CSS once.
Use the fork's installation link in the fragment, not upstream STEVE releases.
Preserve the rest of the host application and its existing engine selection handlers.

## Connect the composer

In `frontend/studio/app.js`, keep one integration promise for the page lifetime:

```js
let steveIntegrationPromise;
function getSteveIntegration() {
  return steveIntegrationPromise ||= import('../cad/steve-design-chat.js?v=20261008-steve-open2')
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
  from '../cad/steve-design-chat.js?v=20261008-steve-open2';
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
Older replies can be recovered only while the running STEVE bridge still retains them.
This watches Render-submitted requests; it does not mirror unrelated Fusion-only chats.

Increment the host app and module query versions on deployment. A green connection badge
alone does not verify chat rendering: the wrapper **and** host rendering hooks are required.
See also the [protocol guide](../../docs/EXTERNAL_BRIDGE.md#live-design-chat-feed-capabilitieschatevents).

## Automatically open the completed design

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
  from '../cad/steve-design-chat.js?v=20261008-steve-open2';
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
