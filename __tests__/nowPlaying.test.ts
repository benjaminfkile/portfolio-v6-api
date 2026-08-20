import request from "supertest";

// Now-playing is listener-only: the public router serves the durable last-known
// payload the connect-listener persisted (never Spotify). This suite has no
// database, so we stub the store's read to control what the router returns.
jest.mock("../src/services/nowPlayingStateStore", () => ({
  getLastNowPlaying: jest.fn().mockResolvedValue(null),
  saveLastNowPlaying: jest.fn().mockResolvedValue(undefined),
}));

import app from "../src/app";
import { getLastNowPlaying } from "../src/services/nowPlayingStateStore";

const mockGetLastNowPlaying = getLastNowPlaying as jest.Mock;

/**
 * GET /api/now-playing — public, listener-only. The endpoint never calls
 * Spotify; it serves the live Redis snapshot, then the leader's in-process
 * copy, then the durable DB last-known, then idle. This suite has no Redis, so
 * it exercises the DB last-known / idle paths.
 */
describe("GET /api/now-playing — public, listener-only, never leaks a token, never 5xx", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
    mockGetLastNowPlaying.mockReset();
    mockGetLastNowPlaying.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("serves the durable last-known playing payload and NEVER calls Spotify", async () => {
    const track = {
      title: "Some Song",
      artists: ["Artist One", "Artist Two"],
      album: "Some Album",
      art_url: "https://i.scdn.co/image/abc",
      url: "https://open.spotify.com/track/xyz",
      progress_ms: 83000,
      duration_ms: 214000,
    };
    mockGetLastNowPlaying.mockResolvedValueOnce({ playing: true, track });

    const res = await request(app).get("/api/now-playing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: true, track });
    // The request path must never touch Spotify.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the durable last-known idle payload (with last_played) verbatim", async () => {
    const lastPlayed = {
      track: {
        title: "Last Song",
        artists: ["Last Artist"],
        album: "Last Album",
        art_url: "https://i.scdn.co/image/last",
        url: "https://open.spotify.com/track/last",
        progress_ms: null,
        duration_ms: 199000,
      },
      played_at: "2026-08-10T20:15:00.000Z",
    };
    mockGetLastNowPlaying.mockResolvedValueOnce({
      playing: false,
      last_played: lastPlayed,
    });

    const res = await request(app).get("/api/now-playing");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false, last_played: lastPlayed });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 { playing: false } (not a 5xx) when there is no last-known payload", async () => {
    mockGetLastNowPlaying.mockResolvedValueOnce(null);

    const res = await request(app).get("/api/now-playing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades to 200 { playing: false } when the last-known read throws", async () => {
    mockGetLastNowPlaying.mockRejectedValueOnce(new Error("db down"));
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get("/api/now-playing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ playing: false });
    errSpy.mockRestore();
  });
});
