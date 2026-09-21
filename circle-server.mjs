import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets'

const apiKey = process.env.CIRCLE_API_KEY
const client = apiKey ? initiateUserControlledWalletsClient({ apiKey }) : null
const app = new Hono()
app.use('/api/*', cors())

function unavailable(c) {
  return c.json({ message: 'CIRCLE_API_KEY is not configured on the Circle backend.' }, 503)
}

app.get('/api/health', (c) => c.json({ ok: true, configured: Boolean(client) }))

async function circleRequest(path, { userToken, body }) {
  const response = await fetch(`https://api.circle.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(userToken ? { 'X-User-Token': userToken } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

app.post('/api/social/token', async (c) => {
  if (!client) return unavailable(c)
  try {
    const { deviceId } = await c.req.json()
    const { data } = await client.createDeviceTokenForSocialLogin({ deviceId })
    return c.json(data)
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/user/initialize', async (c) => {
  if (!apiKey) return unavailable(c)
  try {
    const { userToken } = await c.req.json()
    const { status, body } = await circleRequest('/v1/w3s/user/initialize', {
      userToken,
      body: {
        idempotencyKey: crypto.randomUUID(),
        accountType: 'SCA',
        blockchains: ['ARC-TESTNET'],
      },
    })
    // 155106: the user already has a wallet, nothing to set up.
    if (body.code === 155106) return c.json({ challengeId: null })
    if (status >= 400) return c.json(body, status)
    return c.json(body.data)
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/wallets/list', async (c) => {
  if (!client) return unavailable(c)
  try {
    const { userToken } = await c.req.json()
    const { data } = await client.listWallets({ userToken })
    return c.json(data)
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/wallets/balances', async (c) => {
  if (!client) return unavailable(c)
  try {
    const { userToken, walletId } = await c.req.json()
    const { data } = await client.getWalletTokenBalance({ userToken, walletId })
    return c.json(data)
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

const port = Number(process.env.PORT) || 8787
console.log(`Circle Wallet API listening on http://localhost:${port} (${client ? 'configured' : 'waiting for CIRCLE_API_KEY'})`)
serve({ fetch: app.fetch, port })
