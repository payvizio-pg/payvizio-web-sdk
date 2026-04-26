/**
 * Payvizio Web SDK — drop-in checkout for browser-based merchants.
 *
 * Loads the hosted checkout in a modal iframe and surfaces payment lifecycle
 * events back to the merchant page via callbacks. The merchant page never
 * touches card data — actual card collection happens inside the acquirer's
 * iframe-embedded form, keeping integrators PCI-out-of-scope.
 *
 * Usage (vanilla JS):
 *
 *     const pv = Payvizio.init({ apiBaseUrl: "https://api.payvizio.com" });
 *     pv.checkout({
 *         sessionId: "sess_xxx",
 *         onSuccess: ({ sessionId, status }) => location.assign("/thanks"),
 *         onFailure: ({ sessionId, reason }) => alert("Payment failed: " + reason),
 *         onClose:   () => console.log("user closed checkout"),
 *     });
 */

export interface InitOptions {
    /** API base URL for status polling. e.g. "https://api.payvizio.com" */
    apiBaseUrl: string;

    /** Optional override for the hosted checkout URL. Defaults to {apiBaseUrl}/checkout. */
    checkoutUrl?: string;

    /** Optional polling interval in ms. Defaults to 2500. Set to 0 to disable. */
    pollIntervalMs?: number;
}

export type PaymentStatus =
    | "CREATED" | "INITIATED" | "ROUTED" | "AUTH_PENDING"
    | "AUTHORIZED_PENDING_WEBHOOK" | "THREEDS_REQUIRED"
    | "AUTHORIZED" | "CAPTURED"
    | "AUTH_FAILED" | "FAILED" | "VOIDED" | "EXPIRED" | "CANCELLED";

export interface SessionStatus {
    sessionId: string;
    status: PaymentStatus;
    acquirer?: string;
    redirectUrl?: string;
    amount?: string;
    currency?: string;
}

export interface CheckoutOptions {
    sessionId: string;

    /** Optional theme overrides applied to the modal chrome (not the checkout iframe). */
    theme?: { backdropColor?: string; modalRadiusPx?: number };

    /** Fired whenever a non-terminal status update arrives from polling or postMessage. */
    onUpdate?: (status: SessionStatus) => void;

    /** Fired when the session reaches a successful terminal status (AUTHORIZED or CAPTURED). */
    onSuccess?: (status: SessionStatus) => void;

    /** Fired when the session reaches a failure terminal status. */
    onFailure?: (status: SessionStatus & { reason?: string }) => void;

    /** Fired when the user closes the modal before completion. */
    onClose?: () => void;
}

const TERMINAL_SUCCESS: PaymentStatus[] = ["AUTHORIZED", "CAPTURED"];
const TERMINAL_FAILURE: PaymentStatus[] = ["AUTH_FAILED", "FAILED", "VOIDED", "EXPIRED", "CANCELLED"];

class CheckoutInstance {
    private overlay: HTMLDivElement | null = null;
    private modal: HTMLDivElement | null = null;
    private iframe: HTMLIFrameElement | null = null;
    private pollHandle: number | null = null;
    private messageListener: ((e: MessageEvent) => void) | null = null;
    private closed = false;

    constructor(private readonly init: InitOptions, private readonly opts: CheckoutOptions) {}

    open(): void {
        if (!this.opts.sessionId) {
            throw new Error("[Payvizio] sessionId is required");
        }
        this.renderModal();
        this.installMessageListener();
        if ((this.init.pollIntervalMs ?? 2500) > 0) {
            this.startPolling();
        }
    }

    close(reason: "user" | "complete" = "user"): void {
        if (this.closed) return;
        this.closed = true;
        this.stopPolling();
        if (this.messageListener) {
            window.removeEventListener("message", this.messageListener);
            this.messageListener = null;
        }
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.modal = null;
        this.iframe = null;
        if (reason === "user" && this.opts.onClose) {
            this.opts.onClose();
        }
    }

    // ── Internal: DOM ──────────────────────────────────────────────────────

    private renderModal(): void {
        const theme = this.opts.theme || {};

        this.overlay = document.createElement("div");
        Object.assign(this.overlay.style, {
            position: "fixed",
            inset: "0",
            background: theme.backdropColor || "rgba(15, 23, 42, 0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: "2147483646",          // just under maximum so it sits above page chrome
        });
        this.overlay.setAttribute("data-payvizio-overlay", "");

        this.modal = document.createElement("div");
        Object.assign(this.modal.style, {
            width: "min(440px, 95vw)",
            height: "min(640px, 92vh)",
            background: "#fff",
            borderRadius: `${theme.modalRadiusPx ?? 14}px`,
            overflow: "hidden",
            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            display: "flex",
            flexDirection: "column",
        });

        this.iframe = document.createElement("iframe");
        const checkoutBase = this.init.checkoutUrl
            ?? `${trimSlash(this.init.apiBaseUrl)}/checkout`;
        const url = `${checkoutBase}?session_id=${encodeURIComponent(this.opts.sessionId)}`;
        Object.assign(this.iframe.style, { border: "0", width: "100%", height: "100%", flex: "1" });
        this.iframe.setAttribute("src", url);
        this.iframe.setAttribute("allow", "payment");
        this.iframe.setAttribute("title", "Payvizio Checkout");

        this.overlay.addEventListener("click", (e) => {
            if (e.target === this.overlay) this.close("user");
        });

        this.modal.appendChild(this.iframe);
        this.overlay.appendChild(this.modal);
        document.body.appendChild(this.overlay);
    }

    // ── Internal: messaging + polling ──────────────────────────────────────

    private installMessageListener(): void {
        this.messageListener = (event: MessageEvent) => {
            const data = event.data;
            if (!data || typeof data !== "object") return;
            if ((data as { source?: string }).source !== "payvizio-checkout") return;
            const payload = data as Partial<SessionStatus> & { type?: string; reason?: string };
            if (!payload.sessionId || payload.sessionId !== this.opts.sessionId) return;

            const status = (payload.status as PaymentStatus | undefined) ?? "INITIATED";
            const view: SessionStatus = {
                sessionId: payload.sessionId,
                status,
                acquirer: payload.acquirer,
                redirectUrl: payload.redirectUrl,
                amount: payload.amount,
                currency: payload.currency,
            };
            this.dispatch(view, payload.reason);
        };
        window.addEventListener("message", this.messageListener);
    }

    private startPolling(): void {
        const interval = this.init.pollIntervalMs ?? 2500;
        const tick = async () => {
            if (this.closed) return;
            try {
                const status = await this.fetchStatus();
                this.dispatch(status);
            } catch (err) {
                // Network errors during polling are non-fatal — try again next tick.
                if (typeof console !== "undefined") {
                    console.debug("[Payvizio] poll error", err);
                }
            }
        };
        this.pollHandle = window.setInterval(tick, interval);
    }

    private stopPolling(): void {
        if (this.pollHandle != null) {
            window.clearInterval(this.pollHandle);
            this.pollHandle = null;
        }
    }

    private async fetchStatus(): Promise<SessionStatus> {
        const url = `${trimSlash(this.init.apiBaseUrl)}/api/payments/${encodeURIComponent(this.opts.sessionId)}`;
        const res = await fetch(url, { method: "GET", credentials: "omit" });
        if (!res.ok) throw new Error(`Status fetch failed: HTTP ${res.status}`);
        const json = await res.json() as Partial<SessionStatus>;
        return {
            sessionId: json.sessionId ?? this.opts.sessionId,
            status: (json.status as PaymentStatus | undefined) ?? "INITIATED",
            acquirer: json.acquirer,
            redirectUrl: json.redirectUrl,
            amount: json.amount,
            currency: json.currency,
        };
    }

    private dispatch(status: SessionStatus, reason?: string): void {
        if (this.closed) return;
        if (this.opts.onUpdate) this.opts.onUpdate(status);
        if (TERMINAL_SUCCESS.indexOf(status.status) >= 0) {
            if (this.opts.onSuccess) this.opts.onSuccess(status);
            this.close("complete");
        } else if (TERMINAL_FAILURE.indexOf(status.status) >= 0) {
            if (this.opts.onFailure) this.opts.onFailure({ ...status, reason });
            this.close("complete");
        }
    }
}

function trimSlash(s: string): string {
    return s.replace(/\/+$/, "");
}

export class Payvizio {
    private constructor(private readonly opts: InitOptions) {}

    static init(opts: InitOptions): Payvizio {
        if (!opts || !opts.apiBaseUrl) {
            throw new Error("[Payvizio] apiBaseUrl is required");
        }
        return new Payvizio(opts);
    }

    /** Opens the hosted checkout modal for the given session. */
    checkout(options: CheckoutOptions): { close: () => void } {
        const instance = new CheckoutInstance(this.opts, options);
        instance.open();
        return { close: () => instance.close("user") };
    }
}

// Browser global for non-module integrations: `<script src="payvizio.js"></script>` then `Payvizio.init(...)`.
declare global {
    interface Window {
        Payvizio?: typeof Payvizio;
    }
}
if (typeof window !== "undefined") {
    window.Payvizio = Payvizio;
}
