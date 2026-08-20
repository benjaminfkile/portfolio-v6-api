/**
 * Web-player access token minter tests (task #116 in the listener series).
 *
 * ALL upstream HTTP is mocked (global `fetch`, dispatched by URL): no Spotify,
 * no AWS, no DB is touched. Covered:
 *   - Happy path: server-time then token-exchange, cookie in the `Cookie`
 *     header only, curated `{ token, expiresAtMs }` returned.
 *   - Wire shape: the token endpoint carries the `reason=init` +
 *     `productType=web-player` query params AND the TOTP-style
 *     `totp` + `totpVer` fields the current web player sends.
 *   - Cache: within the token's lifetime, upstream is called ONCE per cookie.
 *   - Single-flight: concurrent cache-miss requests collapse to one exchange.
 *   - Failure classes:
 *       * `invalid_cookie` on 401 / 403 / `isAnonymous:true` bodies.
 *       * `transient` on 5xx, network error, timeout, malformed body.
 *   - Never-logs contract: no `console.log` / `console.warn` /
 *     `console.error` call ever contains the sp_dc value or the minted token.
 */
import {
  mintWebToken,
  WebTokenMintError,
  WEB_TOKEN_EXPIRY_SAFETY_MS,
  _WEB_TOKEN_MINTER_WIRE,
  _resetWebTokenMinterForTests,
} from "../src/services/listener/webTokenMinter";

const mockFetch = jest.fn();

// A recognisably fake sp_dc: if any log call ever includes this substring the
// never-logs assertion fires.
const SP_DC = "SP_DC_SECRET_COOKIE_ABCDEF123456";
const ACCESS_TOKEN = "SP_ACCESS_TOKEN_SECRET_QRSTUV789";
/** A generous, always-in-the-future default expiry so caching tests never race real wall clock. */
const HOUR_MS = 3_600_000;
function futureExpiryMs(): number {
  return Date.now() + HOUR_MS;
}

function serverTimeResponse(seconds = Math.floor(Date.now() / 1000)): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({ serverTime: seconds }),
  } as unknown as Response;
}

function tokenResponse(
  accessToken: string = ACCESS_TOKEN,
  expiresAtMs: number = futureExpiryMs()
): Response {
  return {
    status: 200,
    ok: true,
    json: async () => ({
      accessToken,
      accessTokenExpirationTimestampMs: expiresAtMs,
      isAnonymous: false,
      clientId: "web-client",
    }),
  } as unknown as Response;
}

function statusResponse(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

function isServerTimeUrl(url: string): boolean {
  return url.startsWith(_WEB_TOKEN_MINTER_WIRE.serverTimeEndpoint);
}
function isTokenUrl(url: string): boolean {
  return url.startsWith(_WEB_TOKEN_MINTER_WIRE.tokenEndpoint);
}

beforeEach(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = mockFetch;
  mockFetch.mockReset();
  _resetWebTokenMinterForTests();
});

describe("mintWebToken: happy path + wire shape", () => {
  it("returns { token, expiresAtMs } (minus the safety margin) on 200", async () => {
    const expiresAtMs = Date.now() + HOUR_MS;
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url) ? serverTimeResponse() : tokenResponse(ACCESS_TOKEN, expiresAtMs)
    );

    const result = await mintWebToken(SP_DC);

    expect(result.token).toBe(ACCESS_TOKEN);
    // Reported expiry = the timestamp Spotify said, minus the safety margin.
    expect(result.expiresAtMs).toBe(expiresAtMs - WEB_TOKEN_EXPIRY_SAFETY_MS);
  });

  it("sends the sp_dc ONLY in the Cookie header (not in the URL)", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url) ? serverTimeResponse() : tokenResponse()
    );

    await mintWebToken(SP_DC);

    const tokenCall = mockFetch.mock.calls.find((c) => isTokenUrl(String(c[0])));
    expect(tokenCall).toBeDefined();
    const [url, init] = tokenCall!;
    // The URL string MUST NOT contain the sp_dc plaintext.
    expect(String(url)).not.toContain(SP_DC);
    // The Cookie header is what carries it.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.cookie).toBe(`sp_dc=${SP_DC}`);
  });

  it("token endpoint carries reason=init, productType=web-player, totp AND totpVer", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url) ? serverTimeResponse() : tokenResponse()
    );

    await mintWebToken(SP_DC);

    const tokenCall = mockFetch.mock.calls.find((c) => isTokenUrl(String(c[0])));
    const url = new URL(String(tokenCall![0]));
    expect(url.searchParams.get("reason")).toBe("init");
    expect(url.searchParams.get("productType")).toBe("web-player");
    // The two TOTP params must be present. `totp` is 6 digits, `totpVer`
    // matches the isolated wire constant.
    const totp = url.searchParams.get("totp");
    expect(totp).not.toBeNull();
    expect(totp).toMatch(new RegExp(`^\\d{${_WEB_TOKEN_MINTER_WIRE.totpDigits}}$`));
    expect(url.searchParams.get("totpVer")).toBe(
      String(_WEB_TOKEN_MINTER_WIRE.totpVersion)
    );
  });

  it("fetches server time BEFORE the token exchange (so the TOTP uses Spotify's clock)", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url) ? serverTimeResponse() : tokenResponse()
    );

    await mintWebToken(SP_DC);

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    const serverTimeIdx = urls.findIndex(isServerTimeUrl);
    const tokenIdx = urls.findIndex(isTokenUrl);
    expect(serverTimeIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThan(serverTimeIdx);
  });
});

describe("mintWebToken: cache", () => {
  it("caches the minted token until (expiry - safety margin): one upstream call for repeated mints", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url) ? serverTimeResponse() : tokenResponse()
    );

    await mintWebToken(SP_DC);
    await mintWebToken(SP_DC);
    await mintWebToken(SP_DC);

    // One call to server-time + one call to the token endpoint, total: 2.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.filter((c) => isTokenUrl(String(c[0])))).toHaveLength(1);
  });

  it("re-mints when the cache expires (past expiresAtMs)", async () => {
    // First response: already-expired token (so second call misses the cache).
    const shortLived = Date.now() + 1_000; // already inside the safety margin
    mockFetch.mockImplementationOnce(async () => serverTimeResponse());
    mockFetch.mockImplementationOnce(async () =>
      tokenResponse(ACCESS_TOKEN, shortLived)
    );

    await mintWebToken(SP_DC);

    // Second attempt: expects a fresh pair of upstream calls.
    mockFetch.mockImplementationOnce(async () => serverTimeResponse());
    mockFetch.mockImplementationOnce(async () =>
      tokenResponse("second-token", Date.now() + 3_600_000)
    );

    const second = await mintWebToken(SP_DC);
    expect(second.token).toBe("second-token");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("re-mints when the sp_dc value changes", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url) ? serverTimeResponse() : tokenResponse()
    );

    await mintWebToken(SP_DC);
    await mintWebToken("DIFFERENT_SP_DC_COOKIE_ZYXWVU");

    // Two mints against two different cookies → two full round-trips.
    expect(mockFetch.mock.calls.filter((c) => isTokenUrl(String(c[0])))).toHaveLength(
      2
    );
  });
});

describe("mintWebToken: single-flight", () => {
  it("collapses concurrent cache-miss callers to ONE upstream exchange", async () => {
    let releaseServerTime: (r: Response) => void = () => undefined;
    let releaseToken: (r: Response) => void = () => undefined;
    const serverTimePending = new Promise<Response>((r) => {
      releaseServerTime = r;
    });
    const tokenPending = new Promise<Response>((r) => {
      releaseToken = r;
    });
    mockFetch.mockImplementation((url: string) =>
      isServerTimeUrl(url) ? serverTimePending : tokenPending
    );

    const inFlight = Promise.all([
      mintWebToken(SP_DC),
      mintWebToken(SP_DC),
      mintWebToken(SP_DC),
    ]);

    releaseServerTime(serverTimeResponse());
    releaseToken(tokenResponse());
    const [a, b, c] = await inFlight;

    // Exactly one server-time + one token exchange fired, no matter that
    // three callers awaited concurrently.
    expect(mockFetch.mock.calls.filter((c) => isServerTimeUrl(String(c[0])))).toHaveLength(1);
    expect(mockFetch.mock.calls.filter((c) => isTokenUrl(String(c[0])))).toHaveLength(1);
    expect(a.token).toBe(ACCESS_TOKEN);
    expect(b.token).toBe(ACCESS_TOKEN);
    expect(c.token).toBe(ACCESS_TOKEN);
  });
});

describe("mintWebToken: invalid_cookie failure class", () => {
  it.each([401, 403])(
    "classifies status %s from the token endpoint as invalid_cookie",
    async (status) => {
      mockFetch.mockImplementation(async (url: string) =>
        isServerTimeUrl(url) ? serverTimeResponse() : statusResponse(status)
      );

      await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
        name: "WebTokenMintError",
        kind: "invalid_cookie",
      });
    }
  );

  it("classifies a 200 body with isAnonymous:true as invalid_cookie", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url)
        ? serverTimeResponse()
        : ({
            status: 200,
            ok: true,
            json: async () => ({
              accessToken: "anon-token",
              accessTokenExpirationTimestampMs: Date.now() + 60_000,
              isAnonymous: true,
            }),
          } as unknown as Response)
    );

    const err = (await mintWebToken(SP_DC).catch((e) => e)) as WebTokenMintError;
    expect(err).toBeInstanceOf(WebTokenMintError);
    expect(err.kind).toBe("invalid_cookie");
  });

  it("classifies a missing sp_dc as invalid_cookie without hitting the network", async () => {
    await expect(mintWebToken("")).rejects.toMatchObject({ kind: "invalid_cookie" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does NOT cache an invalid_cookie failure: the next call retries", async () => {
    // First round: 401 rejection.
    mockFetch.mockImplementationOnce(async () => serverTimeResponse());
    mockFetch.mockImplementationOnce(async () => statusResponse(401));

    await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
      kind: "invalid_cookie",
    });

    // Second round: 200 (admin fixed things by clearing the block on Spotify).
    mockFetch.mockImplementationOnce(async () => serverTimeResponse());
    mockFetch.mockImplementationOnce(async () => tokenResponse());

    const ok = await mintWebToken(SP_DC);
    expect(ok.token).toBe(ACCESS_TOKEN);
  });
});

describe("mintWebToken: transient failure class", () => {
  it("classifies 5xx from the token endpoint as transient", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url) ? serverTimeResponse() : statusResponse(503)
    );
    await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
      name: "WebTokenMintError",
      kind: "transient",
    });
  });

  it("classifies a network error from server-time as transient", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (isServerTimeUrl(url)) throw new Error("ECONNRESET");
      return tokenResponse();
    });
    await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("classifies a network error from the token endpoint as transient", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (isServerTimeUrl(url)) return serverTimeResponse();
      throw new Error("ETIMEDOUT");
    });
    await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("classifies a 200 body missing accessToken as transient", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url)
        ? serverTimeResponse()
        : ({
            status: 200,
            ok: true,
            json: async () => ({
              accessTokenExpirationTimestampMs: Date.now() + 60_000,
            }),
          } as unknown as Response)
    );
    await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("classifies a 200 body missing accessTokenExpirationTimestampMs as transient", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url)
        ? serverTimeResponse()
        : ({
            status: 200,
            ok: true,
            json: async () => ({ accessToken: "ok" }),
          } as unknown as Response)
    );
    await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
      kind: "transient",
    });
  });

  it("classifies a server-time body missing serverTime as transient", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url)
        ? ({
            status: 200,
            ok: true,
            json: async () => ({ notServerTime: true }),
          } as unknown as Response)
        : tokenResponse()
    );
    await expect(mintWebToken(SP_DC)).rejects.toMatchObject({
      kind: "transient",
    });
  });
});

describe("mintWebToken: never logs the cookie or the minted token", () => {
  it("no console.log / .warn / .error call ever contains sp_dc or the token", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // Exercise success, invalid_cookie, transient: all three code paths get
      // to touch the module's logging surface (there isn't much of one, and
      // that's the point).
      mockFetch.mockImplementation(async (url: string) =>
        isServerTimeUrl(url) ? serverTimeResponse() : tokenResponse()
      );
      await mintWebToken(SP_DC);
      _resetWebTokenMinterForTests();

      mockFetch.mockImplementationOnce(async () => serverTimeResponse());
      mockFetch.mockImplementationOnce(async () => statusResponse(401));
      await mintWebToken(SP_DC).catch(() => undefined);
      _resetWebTokenMinterForTests();

      mockFetch.mockImplementationOnce(async () => serverTimeResponse());
      mockFetch.mockImplementationOnce(async () => statusResponse(500));
      await mintWebToken(SP_DC).catch(() => undefined);
      _resetWebTokenMinterForTests();

      mockFetch.mockImplementation(async () => {
        throw new Error("boom");
      });
      await mintWebToken(SP_DC).catch(() => undefined);

      for (const spy of [logSpy, warnSpy, errSpy]) {
        for (const call of spy.mock.calls) {
          const serialized = JSON.stringify(call);
          expect(serialized).not.toContain(SP_DC);
          expect(serialized).not.toContain(ACCESS_TOKEN);
        }
      }
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it("error messages describe status/shape only (no sp_dc, no token, no raw body)", async () => {
    mockFetch.mockImplementation(async (url: string) =>
      isServerTimeUrl(url)
        ? serverTimeResponse()
        : ({
            status: 401,
            ok: false,
            json: async () => ({ hint: SP_DC, secretToken: ACCESS_TOKEN }),
          } as unknown as Response)
    );
    const err = await mintWebToken(SP_DC).catch((e) => e);
    expect(err).toBeInstanceOf(WebTokenMintError);
    expect(err.message).not.toContain(SP_DC);
    expect(err.message).not.toContain(ACCESS_TOKEN);
  });
});
