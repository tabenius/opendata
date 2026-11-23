/** Minimal RFC 5322 / MIME writer for raw-message transports (Workers send_email). */
import { formatAddress, validateMessage, type Address, type OutboundMessage } from "@opendata/ports";

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/.{76}/g, "$&\r\n");
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** RFC 2047 encoded-word when needed. */
export function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${btoa(String.fromCharCode(...utf8(value)))}?=`;
}

function address(a: Address): string {
  return a.name ? formatAddress({ email: a.email, name: encodeHeader(a.name) }) : a.email;
}

export function buildMime(message: OutboundMessage, options: { messageId: string; date?: Date }): string {
  validateMessage(message);
  const boundary = `od-${crypto.randomUUID()}`;
  const headers = [
    `From: ${address(message.from)}`,
    `To: ${message.to.map(address).join(", ")}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${(options.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${options.messageId}>`,
    "MIME-Version: 1.0",
    ...(message.replyTo ? [`Reply-To: ${address(message.replyTo)}`] : []),
    ...Object.entries(message.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];
  const alternative = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(utf8(message.text)),
    ...(message.html ? [`--${boundary}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(utf8(message.html))] : []),
    `--${boundary}--`,
  ];
  if (!message.attachments?.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, "", ...alternative, ""].join("\r\n");
  }
  const mixed = `od-mixed-${crypto.randomUUID()}`;
  const parts = [`--${mixed}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, "", ...alternative];
  for (const a of message.attachments) {
    if (/["\r\n]/.test(a.filename) || !/^[\w.+-]+\/[\w.+-]+$/.test(a.contentType)) throw new TypeError("invalid attachment");
    parts.push(`--${mixed}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, "Content-Transfer-Encoding: base64", "", b64(a.content));
  }
  parts.push(`--${mixed}--`);
  return [...headers, `Content-Type: multipart/mixed; boundary="${mixed}"`, "", ...parts, ""].join("\r\n");
}
