export type Bytes = Uint8Array | ArrayBuffer | string;

const encoder = new TextEncoder();

/** Bytes backed by a plain ArrayBuffer (acceptable as a fetch body). */
export type ByteArray = Uint8Array<ArrayBuffer>;

export function toBytes(data: Bytes): ByteArray {
  if (typeof data === "string") return encoder.encode(data) as ByteArray;
  if (data instanceof Uint8Array) {
    return data.buffer instanceof ArrayBuffer ? (data as ByteArray) : (new Uint8Array(data) as ByteArray);
  }
  return new Uint8Array(data);
}

export function utf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function readStream(stream: ReadableStream<Uint8Array>, max = Infinity): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new RangeError(`stream exceeds ${max} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
