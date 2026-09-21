import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { stream } from 'hono/streaming'
import OpenAI from 'openai'
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets'

const apiKey = process.env.CIRCLE_API_KEY
const client = apiKey ? initiateUserControlledWalletsClient({ apiKey }) : null
// DeepSeek's API is OpenAI-compatible; DeepSeek recommends the OpenAI SDK pointed at its base URL.
const deepseek = process.env.DEEPSEEK_API_KEY ? new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY }) : null
const app = new Hono()
app.use('/api/*', cors())

function unavailable(c) {
  return c.json({ message: 'CIRCLE_API_KEY is not configured on the Circle backend.' }, 503)
}

app.get('/api/health', (c) => c.json({ ok: true, configured: Boolean(client), ai: Boolean(deepseek) }))

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

const AI_SYSTEM_PROMPT = `You are LocalMate, a friendly local travel companion inside a web app. Travelers ask you about food, places, culture, and how to plan their time.

Each request includes the traveler's current location, local time, current weather, and a list of real places near them from OpenStreetMap (name, type, straight-line distance, address). Ground your suggestions in that list: prefer places from it and use their names exactly as given. You may also mention well-known landmarks of the area that you are confident exist.

You have no price, rating, opening-hours, or availability data. Never state or estimate any of these, not even as a range, a typical cost, or a budget total. If the traveler mentions a budget or asks what something costs, say briefly that you don't have verified prices and that they can check on site; the app shows the exact amount before they approve any payment. The distances are straight-line, so present them as approximate.

The app can prepare USDC payments on Arc Testnet, but only the traveler can approve them. You cannot book or pay for anything yourself, so never say that something is booked or paid.

Reply in the traveler's language (Vietnamese if they write in Vietnamese). Keep answers short and practical: a sentence of context, then at most five suggestions or steps. Write plain text without Markdown headings, bold, or tables; start list items with "• ". For a plan, give each stop a time based on the local time and distances.

The traveler can only type text here: there is no photo upload, and each question is answered on its own without memory of earlier ones. So don't end with a follow-up question, and if a request needs something you don't have, such as the dishes on a menu to translate, ask them to type it in their next question.`

// Small in-memory limit so the public endpoint can't run up the DeepSeek bill.
const aiHits = new Map()
function aiRateLimited(c) {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.env?.incoming?.socket?.remoteAddress || 'local'
  const now = Date.now()
  const recent = (aiHits.get(ip) || []).filter((t) => now - t < 60_000)
  recent.push(now)
  aiHits.set(ip, recent)
  return recent.length > 10
}

const clip = (value, max) => String(value ?? '').slice(0, max)

function aiUserMessage({ question, location, localTime, weather, places }) {
  const placeLines = (Array.isArray(places) ? places : []).slice(0, 40)
    .map((p) => `- ${clip(p?.name, 120)} | ${clip(p?.kind, 40)} | ${clip(p?.distance, 20)} | ${clip(p?.address, 160)}`)
  return [
    `Location: ${clip(location?.name, 160) || 'unknown'}${Number.isFinite(location?.lat) && Number.isFinite(location?.lon) ? ` (${location.lat.toFixed(4)}, ${location.lon.toFixed(4)})` : ''}`,
    `Local time: ${clip(localTime, 80)}`,
    `Weather: ${clip(weather, 120)}`,
    '<nearby_places source="OpenStreetMap">',
    placeLines.length ? placeLines.join('\n') : '(none loaded yet)',
    '</nearby_places>',
    '',
    `Traveler's question: ${clip(question, 500)}`,
  ].join('\n')
}

app.post('/api/ai/ask', async (c) => {
  if (!deepseek) return c.json({ message: 'DEEPSEEK_API_KEY is not configured on the backend.' }, 503)
  if (aiRateLimited(c)) return c.json({ message: 'Too many questions. Please wait a minute and try again.' }, 429)
  let body
  try { body = await c.req.json() } catch { return c.json({ message: 'Invalid JSON body.' }, 400) }
  if (!String(body?.question || '').trim()) return c.json({ message: 'Question is required.' }, 400)

  c.header('Content-Type', 'application/x-ndjson; charset=utf-8')
  return stream(c, async (out) => {
    const send = (event) => out.write(JSON.stringify(event) + '\n')
    const controller = new AbortController()
    out.onAbort(() => controller.abort())
    try {
      const completion = await deepseek.chat.completions.create({
        model: 'deepseek-flash',
        // Thinking mode takes ~15s before the first word; with the no-prices prompt, non-thinking answers in under a second.
        thinking: { type: 'disabled' },
        max_tokens: 2000,
        stream: true,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: aiUserMessage(body) },
        ],
      }, { signal: controller.signal })
      let finishReason = null
      for await (const chunk of completion) {
        const choice = chunk.choices[0]
        if (choice?.delta?.content) await send({ type: 'text', text: choice.delta.content })
        if (choice?.finish_reason) finishReason = choice.finish_reason
      }
      if (finishReason === 'length') await send({ type: 'error', message: 'The answer was cut off. Try a narrower question.' })
      else if (finishReason === 'content_filter') await send({ type: 'error', message: 'LocalMate cannot help with that request.' })
      else if (finishReason === 'insufficient_system_resource') await send({ type: 'error', message: 'LocalMate AI is busy. Please try again shortly.' })
      await send({ type: 'done' })
    } catch (error) {
      if (controller.signal.aborted) return
      let message = 'LocalMate AI is unavailable right now.'
      if (error instanceof OpenAI.AuthenticationError) message = 'The DeepSeek API key on the backend is invalid.'
      else if (error instanceof OpenAI.RateLimitError) message = 'LocalMate AI is busy. Please try again shortly.'
      else if (error instanceof OpenAI.APIError && error.status === 402) message = 'The DeepSeek account is out of balance.'
      else if (error instanceof OpenAI.APIError) message = `LocalMate AI error (${error.status ?? 'network'}).`
      console.error('AI request failed:', error)
      await send({ type: 'error', message })
    }
  })
})

const port = Number(process.env.PORT) || 8787
console.log(`Circle Wallet API listening on http://localhost:${port} (${client ? 'configured' : 'waiting for CIRCLE_API_KEY'}; AI ${deepseek ? 'configured' : 'waiting for DEEPSEEK_API_KEY'})`)
serve({ fetch: app.fetch, port })
