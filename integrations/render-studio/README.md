# Render Studio frontend integration

This directory packages the Render connector used with this fork: pairing, green/red/amber
status, authenticated submissions, and storage RPC (including the native Fusion folder
picker). It is an integration bundle, not the entire Render Studio application.

## Files to deploy

Copy `steve-connector.js` and `steve-connector.css` into Render's `frontend/cad/`.
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
  return steveIntegrationPromise ||= import('../cad/steve-connector.js?v=steve-storage-1')
    .then(mod => mod.mountSteveConnector({
      getPrompt: () => composer?.getPromptText?.() || '',
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
In the current Render implementation these map to the prompt status renderer and
`steveConnectionState = snapshot.state; syncPromptActiveEngineIndicator()`.
Set `integration.setActive(true)` while the CAD picker is open or STEVE is the selected
workflow; set it false when both close. Set the engine button's `aria-pressed` when
selecting STEVE. Route the composer send action to `integration.submitCurrent()` only
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

The connector submits jobs and reports connection state. To display assistant text and tool
activity in Design Chat, also wire the [event client](../../examples/render-design-chat-client.js)
according to the [feed guide](../../docs/EXTERNAL_BRIDGE.md#live-design-chat-feed-capabilitieschatevents).
Reuse the existing paired secret and correlate events with the returned request ID. Installing
this bundle alone does not persist messages into Render's conversation store.

## Verification

From the repository root:

```sh
node --test integrations/render-studio/steve-connector.test.js
node tests/test_render_storage_settings.mjs
node tests/test_render_chat_client.cjs
```

Connector tests use fake network responses and verify status, pairing, exact signed payloads,
route-specific storage signing, polling, and error handling. The HTML test checks the portable
fragment. These tests do not establish an end-to-end modeling/cloud-save result. Live Fusion
folder selection was observed during development; the subsequent extended timeout change
was not rechecked with a second live modal selection. Render's broader verification had
unrelated failures; this package does not claim the entire host application passes.
