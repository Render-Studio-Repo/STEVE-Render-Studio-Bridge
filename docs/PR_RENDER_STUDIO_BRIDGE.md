# Add an authenticated local bridge for Render Studio

## Summary

This change adds an optional loopback bridge that lets Render Studio submit a prompt to a running STEVE add-in after the user explicitly approves the connection in Fusion.

The integration is deliberately local. Render Studio never receives the user's STEVE provider credentials, and the bridge binds only to `127.0.0.1`.

## User experience

1. The user installs and runs STEVE in Autodesk Fusion and signs in to their model provider as usual.
2. Render Studio detects the local bridge and shows STEVE in its CAD selector.
3. The user chooses **Connect STEVE** in Render Studio.
4. STEVE displays an approval dialog inside Fusion.
5. After approval, Render Studio shows a green status only when Fusion is running, the provider is ready, and STEVE can accept a prompt.
6. A Render Studio prompt is signed locally, queued by the bridge, and dispatched through STEVE's existing controller on Fusion's main thread.
7. The destination defaults to the current Fusion Data Panel folder. An optional Render Studio browser can supply an existing Autodesk project/folder ID and editable design name.

## Security and boundary decisions

- Loopback-only server on `127.0.0.1:38173`.
- Exact `Host` and `Origin` checks; the production origin is `https://render3d.app`.
- User approval is required in Fusion before a shared secret is issued.
- Prompt submissions use HMAC-SHA256 with timestamp, nonce, request ID, and exact-body hashing.
- Replay protection, idempotency, request-size limits, and a bounded queue are enforced.
- The HTTP thread never calls the Fusion `adsk` API. It raises a custom event and execution continues on Fusion's main thread.
- Pairing is intentionally in-memory for this first version, so restarting STEVE requires pairing again.

## API

- `GET /v1/status`
- `POST /v1/pairing/request`
- `POST /v1/pairing/complete`
- `POST /v1/submissions`

The full request and signing contract is documented in `docs/EXTERNAL_BRIDGE.md`.

## Failure behavior

The bridge is optional. If its port is unavailable or it cannot start, STEVE continues loading normally and records the bridge failure in its log. Render Studio shows a recoverable disconnected or error state.

## Testing

- `python3 -m unittest tests.test_external_bridge tests.test_clipboard_bridge tests.test_loopback_http -v`
- `node tests/test_panel.cjs`
- Python compilation and `git diff --check`

## Known limitations and follow-ups

- Validate HTTPS-to-loopback requests and Private Network Access behavior in the supported production browsers.
- Complete an end-to-end test with the add-in loaded in Autodesk Fusion.
- Folder creation is not part of this bridge version. Existing Autodesk project/folder IDs from a Render Studio browser are supported, while the current Fusion folder remains the default.
- Long-term secret persistence can be added later using OS-backed secure storage if persistent pairing is desired.
