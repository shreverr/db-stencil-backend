import { Hono } from 'hono'
import { submitEnterpriseLead } from '../controllers/enterprise.controller'

// Public route — no auth gate. The form is reachable from the pricing
// page including for unauthenticated visitors.
const enterpriseRoutes = new Hono()
enterpriseRoutes.post('/contact', submitEnterpriseLead)

export default enterpriseRoutes
