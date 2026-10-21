import {
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { ConflictError, NotAllowedError, NotFoundError } from '@backstage/errors';

export interface StoredObject {
  key: string;
  size: number;
  lastModified?: string;
}

/** The S3 calls BucketService needs, on one account. */
export interface ObjectStore {
  readonly endpoint: string;
  listBuckets(): Promise<Array<{ name: string; createdAt?: string }>>;
  /** Objects in the bucket, at most `limit`; truncated when there are more. */
  listObjects(bucket: string, limit: number): Promise<{ objects: StoredObject[]; truncated: boolean }>;
  /** Deletes every object (all versions and delete markers) and unfinished upload, then the bucket. */
  deleteBucket(bucket: string): Promise<void>;
}

// A TCP handshake to a reachable store takes milliseconds; the SDK retries (3 attempts) on top of this.
const CONNECT_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** Parallel single-object deletes: DeleteObjects needs checksums not every S3 implementation takes. */
const DELETE_CONCURRENCY = 16;

/** Maps S3 errors onto Backstage's error types (and HTTP codes). */
async function s3Call<T>(fn: () => Promise<T>, what: string): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof S3ServiceException) {
      const message = `${what}: ${e.name}${e.message && e.message !== e.name ? ` (${e.message})` : ''}`;
      if (e.name === 'NoSuchBucket' || e.$metadata?.httpStatusCode === 404) throw new NotFoundError(message);
      if (e.name === 'AccessDenied' || e.$metadata?.httpStatusCode === 403) throw new NotAllowedError(message);
      if (e.$metadata?.httpStatusCode === 409) throw new ConflictError(message);
      throw new Error(message);
    }
    throw e;
  }
}

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly endpoint: string;

  constructor(options: { endpoint: string; region: string; accessKeyId: string; secretAccessKey: string }) {
    this.endpoint = options.endpoint;
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      forcePathStyle: true,
      // Fail fast when the endpoint can't be reached, instead of waiting out the OS's TCP timeout.
      requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
      // Plain SigV4: S3-compatible stores (HyperStore) don't all take the newer checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async listBuckets() {
    const res = await s3Call(() => this.#client.send(new ListBucketsCommand({})), 'listing buckets');
    return (res.Buckets ?? [])
      .filter(b => b.Name)
      .map(b => ({ name: b.Name!, createdAt: b.CreationDate?.toISOString() }));
  }

  async listObjects(bucket: string, limit: number) {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    do {
      const request = new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: token,
        MaxKeys: Math.min(1000, limit - objects.length),
      });
      const res = await s3Call(
        () => this.#client.send(request),
        `listing bucket ${bucket}`,
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token && objects.length < limit);
    return { objects, truncated: Boolean(token) };
  }

  async deleteBucket(bucket: string) {
    // Versions and delete markers too: a versioned bucket only deletes once they're gone.
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const request = new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        VersionIdMarker: versionMarker,
      });
      const res = await s3Call(
        () => this.#client.send(request),
        `listing bucket ${bucket}`,
      );
      const entries = [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])].filter(v => v.Key);
      await forEachLimited(entries, DELETE_CONCURRENCY, v =>
        s3Call(
          () => this.#client.send(new DeleteObjectCommand({ Bucket: bucket, Key: v.Key, VersionId: v.VersionId })),
          `deleting ${bucket}/${v.Key}`,
        ).then(() => undefined),
      );
      keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
      versionMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined;
    } while (keyMarker);

    let uploadMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const request = new ListMultipartUploadsCommand({
        Bucket: bucket,
        KeyMarker: uploadMarker,
        UploadIdMarker: uploadIdMarker,
      });
      const res = await s3Call(
        () => this.#client.send(request),
        `listing uploads in ${bucket}`,
      );
      for (const u of res.Uploads ?? []) {
        await s3Call(
          () => this.#client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: u.Key, UploadId: u.UploadId })),
          `aborting upload ${bucket}/${u.Key}`,
        );
      }
      uploadMarker = res.IsTruncated ? res.NextKeyMarker : undefined;
      uploadIdMarker = res.IsTruncated ? res.NextUploadIdMarker : undefined;
    } while (uploadMarker);

    await s3Call(() => this.#client.send(new DeleteBucketCommand({ Bucket: bucket })), `deleting bucket ${bucket}`);
  }
}
