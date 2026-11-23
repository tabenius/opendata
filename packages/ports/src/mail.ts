export interface Address {
  email: string;
  name?: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutboundMessage {
  from: Address;
  to: Address[];
  subject: string;
  text: string;
  html?: string;
  replyTo?: Address;
  attachments?: Attachment[];
  /** Provider idempotency key where supported (Resend `Idempotency-Key`). */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface SendReceipt {
  provider: string;
  providerMessageId?: string;
  acceptedAt: string;
}

export interface MailCapabilities {
  /** False for the Workers send_email binding restricted to verified destinations. */
  arbitraryRecipients: boolean;
  attachments: boolean;
  maxMessageBytes: number;
}

export interface Mailer {
  readonly name: string;
  capabilities(): MailCapabilities;
  send(message: OutboundMessage): Promise<SendReceipt>;
}

export function formatAddress(address: Address): string {
  if (!address.name) return address.email;
  const escaped = address.name.replace(/["\\]/g, "\\$&");
  return `"${escaped}" <${address.email}>`;
}

/** Reject header injection and obviously malformed addresses at the boundary. */
export function validateAddress(address: Address): void {
  const email = address.email;
  if (!/^[^\s@<>()"',;:\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
    throw new TypeError(`invalid e-mail address ${JSON.stringify(email)}`);
  }
  if (address.name && /[\r\n]/.test(address.name)) throw new TypeError("address name contains a line break");
}

export function validateMessage(message: OutboundMessage): void {
  validateAddress(message.from);
  if (message.to.length === 0) throw new TypeError("message has no recipients");
  message.to.forEach(validateAddress);
  if (message.replyTo) validateAddress(message.replyTo);
  if (/[\r\n]/.test(message.subject)) throw new TypeError("subject contains a line break");
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(value)) throw new TypeError(`invalid header ${name}`);
  }
}
