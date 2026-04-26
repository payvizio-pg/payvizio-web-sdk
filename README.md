# Payvizio Web SDK

Drop-in checkout for browser-based merchants. Opens a hosted checkout modal
and surfaces payment lifecycle events back to your page via callbacks. Card
collection happens inside the acquirer's iframe-embedded form, so integrating
this SDK keeps your site **PCI-out-of-scope**.

## Install

```bash
npm install @payvizio/web-sdk
```

Or via `<script>` tag (UMD bundle exposes `window.Payvizio`):

```html
<script src="https://cdn.payvizio.com/sdk/web/v0/payvizio.umd.js"></script>
```

## Usage

1. Create a payment session on your server (`POST /api/payments` from the merchant API).
2. Hand the returned `sessionId` to the browser page.
3. Call `Payvizio.checkout({ sessionId, ... })`.

```js
const pv = Payvizio.init({
    apiBaseUrl: "https://api.payvizio.com",
});

pv.checkout({
    sessionId: "sess_xxx",
    onSuccess: ({ sessionId, status }) => location.assign("/thanks"),
    onFailure: ({ sessionId, reason }) => alert("Payment failed: " + reason),
    onClose:   () => console.log("user closed checkout"),
});
```

## API

### `Payvizio.init(options)`

| Option           | Type     | Required | Default                        | Notes                                 |
|------------------|----------|----------|--------------------------------|---------------------------------------|
| `apiBaseUrl`     | string   | yes      | —                              | e.g. `https://api.payvizio.com`       |
| `checkoutUrl`    | string   | no       | `${apiBaseUrl}/checkout`       | Override hosted-checkout location.    |
| `pollIntervalMs` | number   | no       | `2500`                         | Set to `0` to disable polling.        |

### `payvizio.checkout(options)`

| Option       | Type                           | Notes                                                 |
|--------------|--------------------------------|-------------------------------------------------------|
| `sessionId`  | string (required)              | from `POST /api/payments`                             |
| `theme`      | `{ backdropColor, modalRadiusPx }` | applies to modal chrome (not the checkout iframe)  |
| `onUpdate`   | `(status) => void`             | every status change                                    |
| `onSuccess`  | `(status) => void`             | terminal success (`AUTHORIZED` or `CAPTURED`)         |
| `onFailure`  | `(status) => void`             | terminal failure (`AUTH_FAILED` / `FAILED` / `VOIDED`) |
| `onClose`    | `() => void`                   | user dismissed before completion                      |

Returns `{ close: () => void }` so you can dismiss programmatically.

## Lifecycle

```
sessionId → checkout() → modal opens
                         │
                         ├─ user pays  → AUTHORIZED → onSuccess → modal closes
                         ├─ user fails → FAILED     → onFailure → modal closes
                         └─ user closes            → onClose
```

The SDK polls `GET /api/payments/{sessionId}` and listens for `postMessage`
events from the checkout iframe (source = `payvizio-checkout`). Either source
can drive the terminal callback.

## What's not in this SDK

- Direct card collection — happens in the acquirer's iframe inside the modal.
- 3DS challenge UI — the acquirer hosts the ACS page; the modal navigates the
  iframe through it transparently.
- Saved-card management — render server-side before opening the SDK, or use
  the dashboard.

## Versioning

Pre-1.0: API may change between minor versions; pin to a specific version in production.
