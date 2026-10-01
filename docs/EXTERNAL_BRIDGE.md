# Render Studio bridge protocol

The external bridge lets Render Studio submit a prompt to STEVE after the user approves a local pairing request. STEVE starts the bridge with its Fusion add-in and stops it when the add-in stops.

The bridge listens only on `127.0.0.1:38173`. It accepts browser requests only from `https://render3d.app`. Tests and development tools can inject other exact origins when they construct `ExternalBridge`; the production add-in does not inject any.

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
