import express, { Request, Response } from "express";
import { IAppSecrets } from "../interfaces";
import { ingestBeacon } from "../services/analyticsService";

/**
 * Public analytics beacon — TECH_SPEC_V1.md §4.8 / §4.1 (`POST /api/beacon`).
 *
 * A thin shell around `analyticsService.ingestBeacon`: it extracts the few
 * request fields the service needs and ALWAYS answers 204 — valid, invalid,
 * dropped, rate-limited, DB down, empty or malformed body, all 204. A broken
 * beacon must never affect a visitor, and probing the endpoint teaches nothing
 * (§4.8 / §3.5). It never throws and never logs request contents.
 *
 * Because the endpoint must survive a MALFORMED JSON body, it parses the body
 * itself with a tolerant parser instead of relying on the app-wide
 * `express.json()` (whose SyntaxError would otherwise reach the error handler
 * and 500). This router is therefore mounted BEFORE the global JSON parser in
 * app.ts.
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
 * Client IP = FIRST `X-Forwarded-For` entry when present (the gateway/ALB sets
 * it), else the socket address. The header is read DIRECTLY — Express `trust
 * proxy` is intentionally NOT enabled (§4.8). Raw IP is hash input only.
 */
function clientIpOf(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[0] : xff;
  if (typeof raw === "string" && raw.length > 0) {
    return raw.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

beaconRouter.post("/", (req: Request, res: Response) => {
  // Ignore any parse error — a missing/garbage body is tolerated by the service.
  parseJsonBody(req, res, async () => {
    const secrets = req.app.get("secrets") as IAppSecrets | undefined;
    await ingestBeacon({
      body: req.body,
      clientIp: clientIpOf(req),
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
