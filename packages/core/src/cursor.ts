export function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor<T>(cursor: string | null | undefined): T | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new RangeError("invalid cursor");
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))) as T;
  } catch {
    throw new RangeError("invalid cursor");
  }
}
