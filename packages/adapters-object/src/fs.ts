/**
 * Filesystem object store using the rbq store layout: an object's key is its
 * path below a dedicated root, so the root is a valid `rbq --storage-root`.
 *
 * Publication follows rebsync's FsObjectStorage: bytes go to a staging file
 * named `<path>#<random>` (outside the key grammar, so never listed), are
 * fsynced, then hard-linked into place for create-if-absent or renamed for
 * replace. Symlinks anywhere below the root are refused. Linux/Node only.
 */
import { constants as FS, createReadStream, promises as fsp } from "node:fs";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  DEFAULT_LIST_LIMIT,
  MAX_KEY_BYTES,
  StorageError,
  isObjectKey,
  toBytes,
  validatePrefix,
  type Bytes,
  type ListOptions,
  type ListPage,
  type ObjectKey,
  type ObjectMeta,
  type ObjectStore,
  type PutOutcome,
  type StorageCapabilities,
} from "@opendata/ports";

function mapError(error: unknown, key: string): never {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (error instanceof StorageError) throw error;
  if (code === "ENOENT" || code === "ENOTDIR") throw StorageError.notFound(key);
  if (code === "EEXIST") throw StorageError.alreadyExists(key);
  if (code === "EACCES" || code === "EPERM") throw new StorageError("PermissionDenied", key);
  throw StorageError.backend(`${key}: ${(error as Error)?.message ?? error}`, error);
}

export class FsObjectStore implements ObjectStore {
  readonly name = "fs";

  private constructor(
    readonly root: string,
    private readonly hardLinks: boolean,
    private readonly ownerOnly: boolean,
  ) {}

  /** Open or create a dedicated root (created 0700). */
  static async open(root: string): Promise<FsObjectStore> {
    if (!root) throw StorageError.invalidKey("storage root is empty");
    let created = false;
    try {
      await fsp.access(root);
    } catch {
      created = true;
    }
    await fsp.mkdir(root, { recursive: true, mode: 0o700 });
    if (created) await fsp.chmod(root, 0o700).catch(() => undefined);
    const canonical = await fsp.realpath(root);
    const stat = await fsp.stat(canonical);
    const ownerOnly = (stat.mode & 0o077) === 0;
    return new FsObjectStore(canonical, await FsObjectStore.probeHardLinks(canonical), ownerOnly);
  }

  private static async probeHardLinks(root: string): Promise<boolean> {
    const nonce = `${process.pid}-${randomBytes(6).toString("hex")}`;
    const source = path.join(root, `.rbq-link-probe-${nonce}`);
    const link = `${source}.link`;
    try {
      await fsp.writeFile(source, "probe");
      await fsp.link(source, link);
      return true;
    } catch {
      return false;
    } finally {
      await fsp.rm(link, { force: true });
      await fsp.rm(source, { force: true });
    }
  }

  capabilities(): StorageCapabilities {
    return {
      atomicCreateIfAbsent: this.hardLinks,
      ownerOnlyPermissions: this.ownerOnly,
      durablePublication: true,
      rangeReads: true,
      rawPrefixListing: true,
      maxKeyBytes: MAX_KEY_BYTES,
    };
  }

  private resolve(key: string): string {
    return path.join(this.root, ...key.split("/"));
  }

  /** Refuse symlinks at any existing component of `key` (leaf included). */
  private async guard(key: string): Promise<void> {
    let current = this.root;
    for (const segment of key.split("/").filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = await fsp.lstat(current);
        if (stat.isSymbolicLink()) throw new StorageError("PermissionDenied", `symlink in storage path: ${key}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private async stage(target: string, data: Uint8Array): Promise<string> {
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const staging = `${target}#${randomBytes(8).toString("hex")}`;
    const handle = await fsp.open(staging, FS.O_CREAT | FS.O_EXCL | FS.O_WRONLY, 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return staging;
  }

  private async syncDir(dir: string): Promise<void> {
    const handle = await fsp.open(dir, "r");
    try {
      await handle.sync();
    } catch {
      // Some filesystems refuse directory fsync; publication is still atomic.
    } finally {
      await handle.close();
    }
  }

  private async metaOf(key: string, file: string): Promise<ObjectMeta> {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw StorageError.notFound(key);
    return { key, size: stat.size, lastModified: stat.mtime, etag: `"${stat.ino.toString(16)}-${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}"` };
  }

  async put(key: ObjectKey, data: Bytes): Promise<ObjectMeta> {
    await this.guard(key);
    const target = this.resolve(key);
    try {
      const staging = await this.stage(target, toBytes(data));
      await fsp.rename(staging, target);
      await this.syncDir(path.dirname(target));
      return await this.metaOf(key, target);
    } catch (error) {
      mapError(error, key);
    }
  }

  async putIfAbsent(key: ObjectKey, data: Bytes): Promise<PutOutcome> {
    await this.guard(key);
    const target = this.resolve(key);
    if (!this.hardLinks) {
      // Check-then-rename: single writer only (FAT/exFAT), as in rbq.
      try {
        return { created: false, meta: await this.head(key) };
      } catch (error) {
        if (!(error instanceof StorageError && error.kind === "NotFound")) throw error;
      }
      return { created: true, meta: await this.put(key, data) };
    }
    let staging: string | undefined;
    try {
      staging = await this.stage(target, toBytes(data));
      await fsp.link(staging, target);
      await this.syncDir(path.dirname(target));
      return { created: true, meta: await this.metaOf(key, target) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false, meta: await this.head(key) };
      return mapError(error, key);
    } finally {
      if (staging) await fsp.rm(staging, { force: true });
    }
  }

  async get(key: ObjectKey): Promise<Uint8Array> {
    await this.guard(key);
    try {
      const file = this.resolve(key);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw StorageError.notFound(key);
      return new Uint8Array(await fsp.readFile(file));
    } catch (error) {
      mapError(error, key);
    }
  }

  async getStream(key: ObjectKey): Promise<ReadableStream<Uint8Array>> {
    await this.guard(key);
    try {
      const file = this.resolve(key);
      const stat = await fsp.stat(file);
      if (!stat.isFile()) throw StorageError.notFound(key);
      return Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
    } catch (error) {
      mapError(error, key);
    }
  }

  async getRange(key: ObjectKey, range: { start: number; end: number }): Promise<Uint8Array> {
    if (range.start >= range.end) throw StorageError.invalidKey(`empty or inverted range ${range.start}..${range.end}`);
    await this.guard(key);
    try {
      const handle = await fsp.open(this.resolve(key), "r");
      try {
        const { size } = await handle.stat();
        if (range.start >= size) throw StorageError.invalidKey("range starts beyond the object");
        const length = Math.min(range.end, size) - range.start;
        const buffer = new Uint8Array(length);
        await handle.read(buffer, 0, length, range.start);
        return buffer;
      } finally {
        await handle.close();
      }
    } catch (error) {
      mapError(error, key);
    }
  }

  async head(key: ObjectKey): Promise<ObjectMeta> {
    await this.guard(key);
    try {
      return await this.metaOf(key, this.resolve(key));
    } catch (error) {
      mapError(error, key);
    }
  }

  async listPrefix(prefix: string, options: ListOptions = {}): Promise<ListPage> {
    validatePrefix(prefix);
    const limit = options.limit || DEFAULT_LIST_LIMIT;
    // Walk the deepest complete directory of the prefix, then filter raw.
    const ancestor = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
    if (ancestor) await this.guard(ancestor);
    const keys: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      let entries;
      try {
        entries = await fsp.readdir(relative ? this.resolve(relative) : this.root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return;
        throw error;
      }
      for (const entry of entries) {
        const key = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (prefix.startsWith(`${key}/`) || key.startsWith(prefix) || `${key}/`.startsWith(prefix)) await walk(key);
        } else if (entry.isFile() && key.startsWith(prefix) && isObjectKey(key) && !entry.name.startsWith(".rbq-")) {
          keys.push(key);
        }
      }
    };
    await walk(ancestor);
    keys.sort();
    const filtered = options.after === undefined ? keys : keys.filter((k) => k > options.after!);
    const page = filtered.slice(0, limit);
    const objects = await Promise.all(page.map((k) => this.metaOf(k, this.resolve(k))));
    return { objects, nextAfter: filtered.length > limit ? page[page.length - 1] : undefined };
  }

  async delete(key: ObjectKey): Promise<void> {
    await this.guard(key);
    await fsp.rm(this.resolve(key), { force: true });
  }
}
