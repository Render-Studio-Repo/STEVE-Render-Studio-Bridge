# Install the Render Studio edition with your AI assistant

Copy this prompt into an AI assistant that can download files, run commands, and operate
Autodesk Fusion on your computer:

> Install https://github.com/wprojects/STEVE-Render-Studio-Bridge for Autodesk Fusion on this computer. Follow docs/INSTALL_WITH_AI.md in that repository. Download and verify the runtime, preserve any existing STEVE data, enable the add-in, help me sign in, and pair it with https://render3d.app. Verify Fusion and Render both show connected and the bridge reports ready, authPing, chatEvents, projectChatHistory, activityFeed, and livePreview support. Do not modify any designs. Tell me if Render still needs the Design Chat integration.

For a different Render instance, replace `https://render3d.app` with its exact address,
including a port when needed. You may need to complete sign-in or approve pairing yourself.

## Instructions for the installing assistant

Use **this fork's source**, not a package from `10-X-eng/STEVE`: upstream packages do not
include this fork's Render bridge. Supported runtime targets are Windows x64 and macOS
Apple silicon. Check the host platform and that Autodesk Fusion is installed first.

1. Clone `https://github.com/wprojects/STEVE-Render-Studio-Bridge.git` into a persistent
   user-owned directory. For an existing checkout, inspect local modifications before
   updating; preserve them and existing STEVE user data. Do not overwrite another STEVE
   installation without preserving it. Do not install two STEVE copies simultaneously.
2. Use Python 3.11 or newer to run `python scripts/fetch_runtime.py` from the repository
   root (use the appropriate Python executable on this machine). This downloads the
   complete runtime for the host and verifies the pinned archive checksum. GitHub source
   archives alone do not contain that runtime. Preserve checksum verification.
3. In Fusion's **Scripts and Add-ins**, add the repository's `addin/STEVE` directory as
   an add-in, run STEVE, and enable **Run on Startup**. Keep the checkout at that location.
   If replacing a running copy, first make sure no STEVE job is active. Save any user work
   before a Fusion restart. The full application need not be closed just to register an
   add-in through Fusion. Use the platform's existing add-in registration when appropriate.
4. Open STEVE from Fusion's toolbar. Complete the selected provider's normal sign-in.
   Never copy login tokens from another application. Wait for the provider to be ready.
5. Click **Render** in STEVE's header or **Settings → Render Studio**. The default Render
   address is `https://render3d.app`. Save another exact origin only when the user requested
   it. The bridge stays on `127.0.0.1:38173`; changing the permitted origin does not turn it
   into a remotely exposed server.
6. In that Render instance, choose **CAD → STEVE → Connect STEVE**, then approve the
   request inside Fusion. Use Render's actual pairing UI so Render receives the secret;
   do not consume the one-time secret with a separate command-line pairing client.
7. Verify `GET http://127.0.0.1:38173/v1/status` with the configured `Origin` header.
   Required results: `fusionRunning: true`, `providerReady: true`, `connected: true`,
   `ready: true`, `capabilities.chatEvents: true`, `capabilities.projectChatHistory: true`,
   `capabilities.activityFeed: true`, and `capabilities.livePreview: true`. Confirm Render says **Ready in
   Fusion**. Do not send a modeling prompt just to check the connection.
8. Tell the user that STEVE uses the active Fusion document when a request starts, and
   the current Data Panel project/folder as its default save destination. Open the intended
   document before sending. Normal STEVE restarts preserve pairing. Changing its Render
   address or clearing the browser’s saved key requires pairing again.

The green header indicator means paired, AI ready, and recent browser activity. A paired
browser can become inactive/red when closed or throttled in the background. The detailed
settings distinguish that from an unpaired connection. **Copy debug log** copies a
connection-only diagnostic report without design prompts or credentials.

## Render developers: Design Chat wiring

Installation enables the Fusion-side feed; it does not automatically update Render's
website. Wire the authenticated live feed into Render's Design Chat using:

- [Protocol and step-by-step wiring instructions](EXTERNAL_BRIDGE.md#live-design-chat-feed-capabilitieschatevents)
- [Production frontend bundle and Design Chat rendering hooks](../integrations/render-studio/README.md#live-design-chat)
- [Dependency-free protocol example](../examples/render-design-chat-client.js)

The dependency-free request client polls at 250 ms. The production background activity
watcher polls every two seconds across projects and supports cursor/epoch recovery. The production bundle renders replies through the host hooks and keeps
account/project-scoped history in browser localStorage. The bridge also retains bounded
public history locally and can recover the latest matching project chat after reconnecting.
Deploy both the chat wrapper and rendering hooks, then refresh the Render page. A prompt using **Jake** is not routed to STEVE, regardless of its AI model selection.

## Render developers: connection and storage UI

Use the [Render frontend bundle](../integrations/render-studio/README.md) for the actual
connector, status markup/CSS, Preferences integration, and native Fusion folder picker.
The bundle reuses the existing paired connection. Choose a destination and press **Use
this folder** to save it; existing documents continue saving in their original location.

## Render developers: live geometry and references

Deploy the latest integration bundle on the Render server as well as updating the Fusion
add-in. Wire `configureSteveLivePreview` to Render's existing Three scene and active
account/project, and use the plain-reference serializer before submitting prompts. See
[the complete wiring guide](../integrations/render-studio/README.md) and
[preview protocol](EXTERNAL_BRIDGE.md#live-fusion-viewport-preview). The viewport preview
is a temporary mesh of the pinned document, independent of saved-file import. It polls
while Design Chat is open. Refresh Render after deploying changed JavaScript. If Render
says to connect first, pair from the browser UI; a green/paired Fusion server alone does
not prove the current browser still holds its pairing key.

Mount `configureSteveActivity` once at application startup for background STEVE
notifications and read-only viewport conversations, independently of the CAD engine
and Design Chat visibility. See the [background wiring recipe](../integrations/render-studio/README.md#background-replies-and-viewport-notifications).
