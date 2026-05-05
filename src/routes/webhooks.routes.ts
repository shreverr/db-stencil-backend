import { Hono } from 'hono'
import { handleDodoWebhook } from '../controllers/billing.controller'

// Webhooks are unauthenticated by design — verified via HMAC signature
// inside the handler instead.
const webhooksRoutes = new Hono()

webhooksRoutes.post('/dodo', handleDodoWebhook)

export default webhooksRoutes
