# STEVE direct Design Chat routing

The [host patch](direct-chat-host.patch) updates only Render Studio's
`frontend/components/render-agent.js`, its Design Chat regression test, and the
`frontend/studio/app.js` reply callback.
It is a review artifact, not an automatic deployment script.

An owned, nonrejected STEVE record selects the direct conversation independently
of the CAD engine picker. The existing STEVE transcript, send button, and hidden
approval controls use that ownership decision. Projects without a STEVE record
retain their existing engine-selected behavior.

Replies pass the original record's `userId`, `projectId`, and `requestId` to
`onSendSteveDesignMessage`. The request ID is named `replyToRequestId` in that
packet. Routing requires a linked native snapshot or a stored `replyToRequestId`
that names another owned, nonrejected record. A locally remembered request is not
proof of native acceptance. Without a safe target, Send retains the draft and
reports that the conversation is not linked yet. It never changes project or engine. A queued reply retains the origin selected when the user submitted it,
even if a newer record arrives before dispatch. Each reply still needs a fresh
submission request ID for idempotency. Do not reuse `replyToRequestId` as that ID.

The parent integration must forward `replyToRequestId` through
`integration.submitCurrent({owner, prompt, replyToRequestId})`. The connector and
native bridge must support signed, validated request-targeted continuation.
A fresh request scoped only to the same project does not identify the original
native thread. This patch does not change those transport modules.

All importers of `steve-design-chat.js` must use the exact same cache-busted URL.
Different query strings instantiate separate chat stores and activity watchers.
The deployed shared version is `20261008-targeted-reply1`; later deployments must retain
one shared version. The patch deliberately contains no import-version
hunk. Bump every Render Agent importer together after integration.

Apply only the diff hunks to a fresh host checkout. Frontend writes are live on
Render Studio. Do not replace the host file with the staged snapshot. The patch
preserves the existing activity changes and adds no project-lock menu.

Verification on 2026-10-08 used synthetic records and a stub transport. The focused
regressions failed before the routing change. After the change, all 49 Design Chat
tests passed; the earlier larger Design Chat check group passed all 78 tests on a freshly
rebased host snapshot. The queued-target and transport-failure follow-ups ran only the focused suite.
The transport regressions use the parent-updated real `SteveDesignChat.submit`
with a failing fake transport. The parent persists `record.replyToRequestId`
before HTTP so an ambiguous continuation retains its original target. JavaScript syntax validation also passed. No real modeling
prompt was sent.

Full feature-map verification remains unverified. Its run stopped on existing
Render Agent import-URL parity and Robot POV cache-marker assertions. The live
watchdog also reports missing mapped paths and requires a new receipt. The parent
owns import unification, final feature receipts, native deployment, and browser
verification. Unit tests do not establish native end-to-end continuation.

Final deployment validation: 131/131 focused Render tests passed; 103/103 portable integration tests and 149 native tests passed. The live Fusion capability advertises targeted replies. Browser inspection showed the direct STEVE transcript, Send to STEVE control, and a mirrored “Test received. No model changes made.” response. No modeling test prompt was sent by this validation pass.
