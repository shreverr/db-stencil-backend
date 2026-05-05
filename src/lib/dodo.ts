/**
 * Thin wrapper over the Dodo Payments REST API.
 *
 * We avoid the SDK so we control timeout / error shape, and so the
 * dependency surface stays small. Endpoints used:
 *   - POST /subscriptions   — recurring (Pro)
 *   - POST /payments        — one-time (Limitless, topup)
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
  name?: string
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
      customer: args.customer,
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
 * Open a one-time-payment checkout (Limitless plan, topup packs).
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
      customer: args.customer,
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
 * Verify webhook signature. Dodo signs the raw body with HMAC-SHA256
 * using the configured webhook secret. We compare in constant time.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
  if (!env.DODO_WEBHOOK_SECRET || !signature) return false
  const expected = crypto.createHmac('sha256', env.DODO_WEBHOOK_SECRET).update(rawBody).digest('hex')
  // Header may be `sha256=<hex>` or `<hex>` depending on dashboard config.
  const provided = signature.startsWith('sha256=') ? signature.slice(7) : signature
  if (expected.length !== provided.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'))
  } catch {
    return false
  }
}
