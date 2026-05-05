import { Hono } from 'hono'
import { supabaseAuth } from '../middleware/middleware'
import {
  getMyBilling,
  getPlanCatalog,
  startCheckout,
  startTopup,
} from '../controllers/billing.controller'

const billingRoutes = new Hono()
billingRoutes.use('/*', supabaseAuth)

billingRoutes.get('/me', getMyBilling)
billingRoutes.get('/plans', getPlanCatalog)
billingRoutes.post('/checkout', startCheckout)
billingRoutes.post('/topup', startTopup)

export default billingRoutes
