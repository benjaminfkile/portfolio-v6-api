import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import { ingestBeacon } from "../services/analyticsService";

/**
 * Public analytics beacon — TECH_SPEC_V1.md §4.8 / §4.1 (`POST /api/beacon`).
 *
 * A thin shell around `analyticsService.ingestBeacon`: it extracts the few
 * request fields the service needs and ALWAYS answers 204 — valid, invalid,
 * dropped, rate-limited, DB down, empty or malformed body, Origin-mismatched
 * beacon, spoofed XFF, all 204. A broken beacon must never affect a visitor,
 * and probing the endpoint teaches nothing (§4.8 / §3.5). It never throws and
 * never logs request contents.
 *
 * Because the endpoint must survive a MALFORMED JSON body, it parses the body
 * itself with a tolerant parser instead of relying on the app-wide
 * `express.json()` (whose SyntaxError would otherwise reach the error handler
 * and 500). This router is therefore mounted BEFORE the global JSON parser in
 * app.ts.
 *
 * Client-IP derivation (§4.8, task #135): Express `trust proxy` is
 * intentionally NOT enabled — the first-entry read of `X-Forwarded-For` that
 * `req.ip` would give is spoofable by any client on a two-appending-hop chain
 * (ALB then YARP gateway both append). Instead the client IP is picked from
 * XFF by TRUSTED HOP COUNT (`BEACON_TRUSTED_PROXY_HOPS`, default 0): with
 * hops = N, the client IP is the entry at index `(length - N)` of the trimmed
 * XFF list — the one appended by the outermost trusted proxy — so any
 * client-supplied leading entries are ignored. With hops = 0, or when the
 * list is shorter than the configured hop count, `req.socket.remoteAddress`
 * is used instead. A client-supplied XFF entry NEVER becomes the client IP.
 * This closes the session_key / rate-limit spoofing hole (both are keyed on
 * that IP).
 *
 * Origin allowlist (§4.8, task #135): when `BEACON_ALLOWED_ORIGINS` is a
 * non-empty comma-separated list of origins, a beacon whose `Origin` header
 * is missing, unparseable, or not an exact match is silently dropped by the
 * service. When the allowlist is empty/unset (dev), every origin is accepted
 * as today. The check lives in `ingestBeacon` so this router stays a thin
 * shell.
 */
const beaconRouter = express.Router();

// A local JSON body parser. `type: () => true` makes it parse every request
// body as JSON regardless of the declared Content-Type — cross-origin
// `navigator.sendBeacon` cannot preflight, so it can only send with a
// CORS-safelisted type (text/plain, or a type-less Blob), and we still need to
// read the JSON payload. On a malformed body it calls back with an error, which
// we deliberately ignore so the endpoint still answers 204.
const parseJsonBody = express.json({ type: () => true });

/**
 * Client IP by trusted-hop count (§4.8). See router-level comment above for
 * the rationale. Only entries appended by TRUSTED proxies can influence the
 * result; a client-supplied leading XFF entry never does.
 */
function clientIpOf(req: Request, trustedHops: number): string {
  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  const entries =
    typeof header === "string"
      ? header
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  if (trustedHops > 0 && entries.length >= trustedHops) {
    return entries[entries.length - trustedHops];
  }
  return req.socket.remoteAddress || "";
}

function trustedHopsOf(secrets: IAppSecrets | undefined): number {
  const raw = secrets?.beacon_trusted_proxy_hops;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

beaconRouter.post("/", (req: Request, res: Response) => {
  // Ignore any parse error — a missing/garbage body is tolerated by the service.
  parseJsonBody(req, res, async () => {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    await ingestBeacon({
      body: req.body,
      clientIp: clientIpOf(req, trustedHopsOf(secrets)),
      userAgent:
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : "",
      siteOrigin:
        typeof req.headers.origin === "string" ? req.headers.origin : undefined,
      secrets,
    });
    res.status(204).end();
  });
});

export default beaconRouter;
