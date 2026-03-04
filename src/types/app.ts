import type { JWTPayload } from 'jose'

export type AppEnv = {
  Variables: {
    user: JWTPayload
  }
}
