/**
 * Thin wrapper over the Dodo Payments REST API.
 *
 * We avoid the SDK so we control timeout / error shape, and so the
 * dependency surface stays small. Endpoints used:
 *   - POST /subscriptions   — recurring (Pro)
 *   - POST /payments        — one-time (topup packs)
 *
 * Webhook verification: HMAC-SHA256 of the raw request body using
 * `DODO_WEBHOOK_SECRET`, compared in constant time against the
 * `webhook-signature` header.
 */
import { env } from '../config/env'
import crypto from 'crypto'

interface DodoCheckoutResponse {
  payment_id?: string
  subscription_id?: string
  payment_link?: string
  client_secret?: string
}

interface CustomerInfo {
  email: string
  name: string
}

/**
 * Dodo's CustomerRequest is an untagged enum: either an existing-customer
 * reference (`{ customer_id }`) or a new-customer create (`{ email, name,
 * create_new_customer: true }`). We always create — Dodo dedupes by email
 * server-side so resubscribes still hit the same customer record.
 */
function customerPayload(c: CustomerInfo) {
  return {
    email: c.email,
    name: c.name,
    create_new_customer: true,
  }
}

interface BillingAddress {
  country: string
  state?: string
  city?: string
  street?: string
  zipcode?: string
}

const DEFAULT_BILLING: BillingAddress = {
  country: 'US',
  state: 'CA',
  city: 'San Francisco',
  street: '',
  zipcode: '94103',
}

function authHeader() {
  if (!env.DODO_API_KEY) {
    throw new Error('DODO_API_KEY not configured — set it in .env to enable checkout')
  }
  return { Authorization: `Bearer ${env.DODO_API_KEY}`, 'Content-Type': 'application/json' }
}

/**
 * Open a recurring-subscription checkout (Pro plan).
 * Dodo returns a hosted `payment_link` we redirect the user to.
 */
export async function createSubscriptionCheckout(args: {
  productId: string
  customer: CustomerInfo
  metadata: Record<string, string>
  returnUrl: string
}): Promise<DodoCheckoutResponse> {
  const res = await fetch(`${env.DODO_API_URL}/subscriptions`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({
      product_id: args.productId,
      quantity: 1,
      payment_link: true,
      customer: customerPayload(args.customer),
      billing: DEFAULT_BILLING,
      metadata: args.metadata,
      return_url: args.returnUrl,
    }),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Dodo subscription create failed: ${res.status} ${txt.slice(0, 300)}`)
  }
  return (await res.json()) as DodoCheckoutResponse
}

/**
 * Open a one-time-payment checkout (topup packs).
 */
export async function createPaymentCheckout(args: {
  productId: string
  customer: CustomerInfo
  metadata: Record<string, string>
  returnUrl: string
}): Promise<DodoCheckoutResponse> {
  const res = await fetch(`${env.DODO_API_URL}/payments`, {
    method: 'POST',
    headers: authHeader(),
    body: JSON.stringify({
      product_cart: [{ product_id: args.productId, quantity: 1 }],
      payment_link: true,
      customer: customerPayload(args.customer),
      billing: DEFAULT_BILLING,
      metadata: args.metadata,
      return_url: args.returnUrl,
    }),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Dodo payment create failed: ${res.status} ${txt.slice(0, 300)}`)
  }
  return (await res.json()) as DodoCheckoutResponse
}

/**
 * Verify a Dodo webhook (Svix-format) signature.
 *
 * Svix scheme:
 *   - secret: stored as `whsec_<base64>`; the part after the prefix is the
 *     base64-encoded HMAC key.
 *   - signed payload string: `${webhook-id}.${webhook-timestamp}.${body}`
 *   - signature header: `webhook-signature: v1,<base64> [v1,<base64>...]`
 *     (multiple sigs allowed during key rotation; any valid one passes).
 *   - replay protection: reject if `webhook-timestamp` is older than 5 min.
 *
 * Returns `{ ok: true }` on success, or `{ ok: false, reason }` on failure.
 */
export function verifyWebhookSignature(args: {
  body: string
  msgId?: string
  timestamp?: string
  signatureHeader?: string
}): { ok: true } | { ok: false; reason: string } {
  if (!env.DODO_WEBHOOK_SECRET) return { ok: false, reason: 'no_secret_configured' }
  const { body, msgId, timestamp, signatureHeader } = args
  if (!msgId || !timestamp || !signatureHeader) return { ok: false, reason: 'missing_headers' }

  // Replay window: ±5 minutes around now.
  const ts = parseInt(timestamp, 10)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' }
  const skew = Math.abs(Date.now() / 1000 - ts)
  if (skew > 300) return { ok: false, reason: 'timestamp_out_of_window' }

  // Strip `whsec_` prefix and base64-decode to raw key bytes.
  const rawSecret = env.DODO_WEBHOOK_SECRET.startsWith('whsec_')
    ? env.DODO_WEBHOOK_SECRET.slice(6)
    : env.DODO_WEBHOOK_SECRET
  let keyBytes: Buffer
  try { keyBytes = Buffer.from(rawSecret, 'base64') }
  catch { return { ok: false, reason: 'bad_secret' } }

  const expected = crypto
    .createHmac('sha256', keyBytes)
    .update(`${msgId}.${timestamp}.${body}`)
    .digest()

  // Header may carry several space-separated `v1,<sig>` pairs.
  for (const part of signatureHeader.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    let provided: Buffer
    try { provided = Buffer.from(sig, 'base64') }
    catch { continue }
    if (provided.length !== expected.length) continue
    try {
      if (crypto.timingSafeEqual(provided, expected)) return { ok: true }
    } catch { /* length mismatch */ }
  }
  return { ok: false, reason: 'no_valid_signature' }
}
