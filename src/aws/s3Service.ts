import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectTaggingCommand,
  DeleteObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * S3 access for portfolio media — TECH_SPEC_V1.md §6.7–§6.9.
 *
 * All S3 access is isolated here (task requirement), with the init/singleton,
 * `getSignedUrl` and `HeadObject` patterns ported from
 * `file-manager-api/src/aws/s3Service.ts`. Portfolio uses a single presigned PUT
 * per object (§6.7), not multipart, so the multipart/download/CloudFront-signing
 * helpers from the reference are intentionally NOT ported — the media path is
 * public-read behind CloudFront (§6.1) and needs none of them.
 *
 * Nothing here runs against real AWS in tests: the whole module is fully mocked
 * (hard rule / §7 of pre-checks). The code is written to be correct against live
 * S3 regardless.
 */

let s3: S3Client | null = null;
let bucket: string | null = null;

export function initS3(bucketName: string): void {
  if (s3) return;
  s3 = new S3Client({ region: process.env.AWS_REGION });
  bucket = bucketName;
}

function getClient(): S3Client {
  if (!s3) {
    throw new Error("S3 has not been initialized. Call initS3() first.");
  }
  return s3;
}

function getBucket(): string {
  if (!bucket) {
    throw new Error("S3 has not been initialized. Call initS3() first.");
  }
  return bucket;
}

export function getS3Client(): S3Client {
  return getClient();
}

export function getBucketName(): string {
  return getBucket();
}

/** Test/teardown helper: forget the client + bucket so a fresh init can run. */
export function resetS3(): void {
  s3 = null;
  bucket = null;
}

/** Object key strategy — `media/{uuid}/{original-filename}` (§6.4). */
export function buildMediaKey(uuid: string, filename: string): string {
  return `media/${uuid}/${filename}`;
}

export interface PresignedUpload {
  url: string;
  /** Headers the client MUST send on the PUT, byte-for-byte (§6.7 gotcha). */
  headers: Record<string, string>;
}

/**
 * Presigned S3 PUT (§6.7). `Cache-Control`, `Content-Type` AND `Tagging` are
 * declared on the command and forced into the SignatureV4 signed-header set
 * (rather than hoisted to the query string), so they are pinned into the
 * signature: S3 accepts the PUT only if the client sends byte-identical headers.
 *
 * GOTCHA (§6.7): because `Tagging` is signed, the client's `x-amz-tagging`
 * header must equal `tagging` (e.g. "state=pending") byte-for-byte, and its
 * `Content-Type` / `Cache-Control` must match too, or S3 rejects the upload with
 * a 403 — the single most likely source of a confusing upload failure. The exact
 * headers to echo are returned in `headers`.
 */
export async function generatePresignedUploadUrl(params: {
  key: string;
  contentType: string;
  cacheControl: string;
  tagging: string;
  expiresInSeconds: number;
}): Promise<PresignedUpload> {
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: params.key,
    ContentType: params.contentType,
    CacheControl: params.cacheControl,
    Tagging: params.tagging,
  });

  const url = await getSignedUrl(getClient(), command, {
    expiresIn: params.expiresInSeconds,
    // Keep these out of the query string and inside the signed-header set so the
    // client is obliged to echo them exactly — that is what "pinned into the
    // signature" means in §6.7.
    signableHeaders: new Set(["content-type", "cache-control", "x-amz-tagging"]),
    unhoistableHeaders: new Set(["x-amz-tagging"]),
  });

  return {
    url,
    headers: {
      "Content-Type": params.contentType,
      "Cache-Control": params.cacheControl,
      "x-amz-tagging": params.tagging,
    },
  };
}

export interface HeadResult {
  contentLength: number;
  contentType: string;
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NotFound" ||
    e?.name === "NotFoundException" ||
    e?.name === "NoSuchKey" ||
    e?.$metadata?.httpStatusCode === 404
  );
}

/**
 * HEAD an object. Returns `null` when S3 reports it does not exist (404 /
 * NotFound); any other error propagates. Used by confirm to verify the upload
 * landed (§6.7) and by the GC pass to detect objects the S3 lifecycle rule has
 * already expired (§6.9).
 */
export async function headObject(key: string): Promise<HeadResult | null> {
  try {
    const res = await getClient().send(
      new HeadObjectCommand({ Bucket: getBucket(), Key: key })
    );
    return {
      contentLength: Number(res.ContentLength ?? 0),
      contentType: res.ContentType ?? "application/octet-stream",
    };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Replace an object's entire tag set (§6.9) — e.g. `{ state: "orphaned" }`. */
export async function putObjectTags(
  key: string,
  tags: Record<string, string>
): Promise<void> {
  await getClient().send(
    new PutObjectTaggingCommand({
      Bucket: getBucket(),
      Key: key,
      Tagging: {
        TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
      },
    })
  );
}

/**
 * Remove all tags from an object. Confirm uses this to drop `state=pending`
 * (§6.7); the GC rescue path uses it to drop `state=orphaned` (§6.9). In both
 * cases exactly one `state=*` tag exists, so clearing the set is the removal.
 */
export async function deleteObjectTags(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectTaggingCommand({ Bucket: getBucket(), Key: key })
  );
}

export async function deleteObject(key: string): Promise<void> {
  await getClient().send(
    new DeleteObjectCommand({ Bucket: getBucket(), Key: key })
  );
}
