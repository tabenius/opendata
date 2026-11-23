/**
 * One error taxonomy for every port, mirroring rbq's `StorageError`.
 * HTTP mapping follows rebsync `transport.rs::storage_response`.
 */
export type StorageErrorKind =
  | "InvalidKey"
  | "NotFound"
  | "AlreadyExists"
  | "PermissionDenied"
  | "Unavailable"
  | "Corrupt"
  | "Unsupported"
  | "Backend";

const HTTP: Record<StorageErrorKind, number> = {
  InvalidKey: 400,
  NotFound: 404,
  AlreadyExists: 409,
  PermissionDenied: 403,
  Unavailable: 503,
  Unsupported: 501,
  Corrupt: 500,
  Backend: 500,
};

const PREFIX: Record<StorageErrorKind, string> = {
  InvalidKey: "invalid object key",
  NotFound: "object not found",
  AlreadyExists: "object already exists",
  PermissionDenied: "permission denied",
  Unavailable: "storage unavailable",
  Corrupt: "storage integrity failure",
  Unsupported: "unsupported operation",
  Backend: "storage backend error",
};

export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly detail: string;

  constructor(kind: StorageErrorKind, detail: string, options?: { cause?: unknown }) {
    super(`${PREFIX[kind]}: ${detail}`, options);
    this.name = "StorageError";
    this.kind = kind;
    this.detail = detail;
  }

  get httpStatus(): number {
    return HTTP[this.kind];
  }

  static invalidKey(detail: string) {
    return new StorageError("InvalidKey", detail);
  }
  static notFound(detail: string) {
    return new StorageError("NotFound", detail);
  }
  static alreadyExists(detail: string) {
    return new StorageError("AlreadyExists", detail);
  }
  static corrupt(detail: string) {
    return new StorageError("Corrupt", detail);
  }
  static unsupported(detail: string) {
    return new StorageError("Unsupported", detail);
  }
  static unavailable(detail: string, cause?: unknown) {
    return new StorageError("Unavailable", detail, { cause });
  }
  static backend(detail: string, cause?: unknown) {
    return new StorageError("Backend", detail, { cause });
  }
}

export function isStorageError(error: unknown, kind?: StorageErrorKind): error is StorageError {
  return error instanceof StorageError && (kind === undefined || error.kind === kind);
}

export function httpStatusFor(kind: StorageErrorKind): number {
  return HTTP[kind];
}
