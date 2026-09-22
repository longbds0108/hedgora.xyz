// Hedgora API. Vercel runs this file as a function (framework preset "hono");
// locally, circle-server.mjs serves it together with public/.
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import OpenAI from 'openai'
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets'

const apiKey = process.env.CIRCLE_API_KEY
const client = apiKey ? initiateUserControlledWalletsClient({ apiKey }) : null
// DeepSeek's API is OpenAI-compatible; DeepSeek recommends the OpenAI SDK pointed at its base URL.
const deepseek = process.env.DEEPSEEK_API_KEY ? new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY }) : null
// VietMap covers Vietnam only (Vietnamese addresses, car and motorbike routes); outside it the pages use Photon and OSRM.
const vietmapKey = process.env.VIETMAP_API_KEY
const app = new Hono()

function unavailable(c) {
  return c.json({ message: 'CIRCLE_API_KEY is not configured on the Circle backend.' }, 503)
}

// On Vercel the Hono function is deployed as the "index" route, which shadows public/index.html at "/",
// so the function serves the homepage itself (locally, circle-server.mjs serves public/ first).
// Reading it via import.meta.url lets Vercel trace the file into the function bundle.
const homepage = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
app.get('/', (c) => c.html(homepage))

app.get('/api/health', (c) => c.json({ ok: true, configured: Boolean(client), ai: Boolean(deepseek), map: Boolean(vietmapKey) }))

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

// USDC is Arc's native gas token; Circle accepts its ERC-20 interface address for transfers (6 decimals).
const ARC_USDC = { tokenAddress: '0x3600000000000000000000000000000000000000', blockchain: 'ARC-TESTNET' }
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value ?? ''))
const isAmount = (value) => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(String(value ?? '')) && Number(value) > 0

// Pass Circle's 4xx errors (e.g. 155208 "execution reverted" on an empty wallet) through with their message.
function circleError(c, error) {
  const status = error?.status ?? error?.response?.status
  return c.json({ message: error instanceof Error ? error.message : String(error), code: error?.code }, status >= 400 && status < 500 ? status : 502)
}

app.post('/api/transactions/list', async (c) => {
  if (!client) return unavailable(c)
  try {
    const { userToken, walletId, pageAfter, destinationAddress, pageSize } = await c.req.json()
    const { data } = await client.listTransactions({
      userToken,
      walletIds: walletId ? [walletId] : undefined,
      // Circle paginates by transaction id (UUID); destinationAddress answers "have I paid this address before?".
      pageAfter: /^[0-9a-f-]{36}$/i.test(String(pageAfter ?? '')) ? pageAfter : undefined,
      destinationAddress: isAddress(destinationAddress) ? destinationAddress : undefined,
      pageSize: Math.min(Math.max(Number(pageSize) || 20, 1), 50),
      order: 'DESC',
    })
    return c.json(data)
  } catch (error) {
    return circleError(c, error)
  }
})

app.post('/api/transfers/estimate', async (c) => {
  if (!client) return unavailable(c)
  try {
    const { userToken, walletId, destinationAddress, amount } = await c.req.json()
    if (!isAddress(destinationAddress) || !isAmount(amount)) return c.json({ message: 'Invalid recipient address or amount.' }, 400)
    const { data } = await client.estimateTransferFee({ userToken, walletId, ...ARC_USDC, destinationAddress, amount: [String(amount)] })
    return c.json(data)
  } catch (error) {
    return circleError(c, error)
  }
})

// Creates a transfer challenge only; nothing moves until the traveler approves it in Circle's hosted UI.
app.post('/api/transfers/create', async (c) => {
  if (!client) return unavailable(c)
  try {
    const { userToken, walletId, destinationAddress, amount, note } = await c.req.json()
    if (!isAddress(destinationAddress) || !isAmount(amount)) return c.json({ message: 'Invalid recipient address or amount.' }, 400)
    const { data } = await client.createTransaction({
      userToken,
      walletId,
      ...ARC_USDC,
      destinationAddress,
      amounts: [String(amount)],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      refId: String(note ?? '').trim().slice(0, 60) || undefined,
    })
    return c.json(data)
  } catch (error) {
    return circleError(c, error)
  }
})

const AI_SYSTEM_PROMPT = `You are Hedgora, a friendly local travel companion inside a web app. Travelers ask you about food, places, culture, and how to plan their time.

Each request includes the traveler's current location, local time, current weather, and a list of real places near them from OpenStreetMap (name, type, straight-line distance, address). Ground your suggestions in that list: prefer places from it and use their names exactly as given. You may also mention well-known landmarks of the area that you are confident exist.

You have no price, rating, opening-hours, or availability data. Never state or estimate any of these, not even as a range, a typical cost, or a budget total. If the traveler mentions a budget or asks what something costs, say briefly that you don't have verified prices and that they can check on site; the app shows the exact amount before they approve any payment. The distances are straight-line, so present them as approximate.

The app can prepare USDC payments on Arc Testnet, but only the traveler can approve them. You cannot book or pay for anything yourself, so never say that something is booked or paid.

Reply in the traveler's language (Vietnamese if they write in Vietnamese). Keep answers short and practical: a sentence of context, then at most five suggestions or steps. Write plain text without Markdown headings, bold, or tables; start list items with "• ". For a plan, give each stop a time based on the local time and distances.

The traveler can only type text here: there is no photo upload, and each question is answered on its own without memory of earlier ones. So don't end with a follow-up question, and if a request needs something you don't have, such as the dishes on a menu to translate, ask them to type it in their next question.`

// Small in-memory per-IP limits so the public endpoints can't run up the DeepSeek or VietMap bills.
function rateLimiter(perMinute) {
  const hits = new Map()
  return (c) => {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.env?.incoming?.socket?.remoteAddress || 'local'
    const now = Date.now()
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000)
    recent.push(now)
    hits.set(ip, recent)
    return recent.length > perMinute
  }
}
const aiRateLimited = rateLimiter(10)
const mapRateLimited = rateLimiter(60)

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
      else if (finishReason === 'content_filter') await send({ type: 'error', message: 'Hedgora cannot help with that request.' })
      else if (finishReason === 'insufficient_system_resource') await send({ type: 'error', message: 'Hedgora AI is busy. Please try again shortly.' })
      await send({ type: 'done' })
    } catch (error) {
      if (controller.signal.aborted) return
      let message = 'Hedgora AI is unavailable right now.'
      if (error instanceof OpenAI.AuthenticationError) message = 'The DeepSeek API key on the backend is invalid.'
      else if (error instanceof OpenAI.RateLimitError) message = 'Hedgora AI is busy. Please try again shortly.'
      else if (error instanceof OpenAI.APIError && error.status === 402) message = 'The DeepSeek account is out of balance.'
      else if (error instanceof OpenAI.APIError) message = `Hedgora AI error (${error.status ?? 'network'}).`
      console.error('AI request failed:', error)
      await send({ type: 'error', message })
    }
  })
})

const ITINERARY_PROMPT = `You plan short, realistic itineraries for Hedgora, a travel companion app.

You get the traveler's local time (24h), weather, and a numbered list of real places near them from OpenStreetMap (type, straight-line distance from the traveler, address). Plan the next few hours as 3 or 4 stops:
- Use only places from the list, referenced by their number, each at most once.
- Start at the next round quarter hour after the local time. Leave realistic gaps for travel between stops.
- Fit the time of day: meals around meal times, cafés for breaks, sights in daylight, viewpoints or beaches near sunset. Prefer indoor places when it rains. At night, keep it short and close by.
- Keep travel short: order stops so the route does not zigzag.
- You have no prices, ratings or opening hours. Never mention or guess them.

Write in English. Respond with JSON only, in this shape:
{"summary": "one sentence about the plan", "stops": [{"place": 0, "start": "HH:MM", "minutes": 60, "activity": "Lunch", "tip": "One short sentence on what to do there."}]}`

// Plans 3–4 stops from the real places the page sends; the model may only pick places by index.
app.post('/api/ai/itinerary', async (c) => {
  if (!deepseek) return c.json({ message: 'DEEPSEEK_API_KEY is not configured on the backend.' }, 503)
  if (aiRateLimited(c)) return c.json({ message: 'Too many requests. Please wait a minute and try again.' }, 429)
  let body
  try { body = await c.req.json() } catch { return c.json({ message: 'Invalid JSON body.' }, 400) }
  const places = (Array.isArray(body?.places) ? body.places : []).slice(0, 40)
  if (places.length < 2) return c.json({ message: 'Not enough nearby places to plan an itinerary.' }, 400)
  const { location, localTime, weather } = body
  const context = [
    `Location: ${clip(location?.name, 160) || 'unknown'}`,
    `Local time: ${clip(localTime, 40)}`,
    `Weather: ${clip(weather, 120)}`,
    '<places source="OpenStreetMap">',
    ...places.map((p, i) => `[${i}] ${clip(p?.name, 120)} | ${clip(p?.kind, 40)} | ${clip(p?.distance, 20)} | ${clip(p?.address, 160)}`),
    '</places>',
  ].join('\n')
  try {
    const completion = await deepseek.chat.completions.create({
      model: 'deepseek-flash',
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      messages: [
        { role: 'system', content: ITINERARY_PROMPT },
        { role: 'user', content: context },
      ],
    })
    let plan
    try { plan = JSON.parse(completion.choices[0]?.message?.content || '') } catch { plan = null }
    // Keep only stops that point at a real place from the list, once each, with a sane time and duration.
    const seen = new Set()
    const stops = (Array.isArray(plan?.stops) ? plan.stops : [])
      .filter((stop) => Number.isInteger(stop?.place) && stop.place >= 0 && stop.place < places.length && !seen.has(stop.place) && seen.add(stop.place))
      .filter((stop) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(stop.start)))
      .slice(0, 5)
      .map((stop) => ({
        place: stop.place,
        start: stop.start,
        minutes: Math.min(Math.max(Math.round(Number(stop.minutes) || 45), 15), 240),
        activity: clip(stop.activity, 40) || 'Visit',
        tip: clip(stop.tip, 200),
      }))
    if (stops.length < 2) return c.json({ message: 'Hedgora AI could not build a plan from the nearby places. Try again.' }, 502)
    return c.json({ summary: clip(plan.summary, 240), stops })
  } catch (error) {
    let message = 'Hedgora AI is unavailable right now.'
    if (error instanceof OpenAI.AuthenticationError) message = 'The DeepSeek API key on the backend is invalid.'
    else if (error instanceof OpenAI.RateLimitError) message = 'Hedgora AI is busy. Please try again shortly.'
    else if (error instanceof OpenAI.APIError && error.status === 402) message = 'The DeepSeek account is out of balance.'
    console.error('Itinerary request failed:', error)
    return c.json({ message }, 502)
  }
})

// Map endpoints: VietMap calls stay on the server so the key never reaches the browser.
const isLat = (v) => Number.isFinite(v) && Math.abs(v) <= 90
const isLon = (v) => Number.isFinite(v) && Math.abs(v) <= 180
function mapGuard(c) {
  if (!vietmapKey) return c.json({ message: 'VIETMAP_API_KEY is not configured on the backend.' }, 503)
  if (mapRateLimited(c)) return c.json({ message: 'Too many map requests. Please wait a minute and try again.' }, 429)
  return null
}

// Names a spot as "ward, district or city", e.g. "Phường Thắng Tam, Thành Phố Vũng Tàu". 404 outside Vietnam.
app.get('/api/map/reverse', async (c) => {
  const blocked = mapGuard(c)
  if (blocked) return blocked
  const lat = Number(c.req.query('lat')), lon = Number(c.req.query('lon'))
  if (!isLat(lat) || !isLon(lon)) return c.json({ message: 'Invalid coordinates.' }, 400)
  try {
    const r = await fetch('https://maps.vietmap.vn/api/reverse/v3?' + new URLSearchParams({ apikey: vietmapKey, lat, lng: lon }))
    const list = r.ok ? await r.json() : []
    // Boundary types: 2 = ward, 1 = district or city, 0 = province.
    const boundaries = (Array.isArray(list) && list[0]?.boundaries) || []
    const level = (type) => boundaries.find((b) => b.type === type)?.full_name
    const name = [level(2), level(1) || level(0)].filter(Boolean).join(', ')
    if (!name) return c.json({ message: 'VietMap has no address for this spot.' }, 404)
    return c.json({ name })
  } catch {
    return c.json({ message: 'VietMap is unavailable right now.' }, 502)
  }
})

// Car or motorbike route through 2–8 points ("lat,lon;lat,lon"), returned in the same shape as an OSRM route:
// metres, seconds, a GeoJSON line and one leg per stop. 404 when VietMap has no route (e.g. outside Vietnam).
app.get('/api/map/route', async (c) => {
  const blocked = mapGuard(c)
  if (blocked) return blocked
  const vehicle = c.req.query('vehicle') === 'car' ? 'car' : 'motorcycle'
  const points = String(c.req.query('points') || '').split(';').map((p) => p.split(',').map(Number))
  if (points.length < 2 || points.length > 8 || points.some(([lat, lon]) => !isLat(lat) || !isLon(lon))) return c.json({ message: 'Send 2 to 8 points as lat,lon;lat,lon.' }, 400)
  const params = new URLSearchParams({ apikey: vietmapKey, vehicle, points_encoded: 'false' })
  points.forEach(([lat, lon]) => params.append('point', `${lat},${lon}`))
  try {
    const r = await fetch('https://maps.vietmap.vn/api/route/v3?' + params)
    const data = r.ok ? await r.json() : null
    const path = data?.code === 'OK' && data.paths?.[0]
    if (!path?.points?.coordinates) return c.json({ message: 'VietMap found no route here.' }, 404)
    // VietMap marks each intermediate stop with sign 5 and the destination with sign 4.
    const legs = [{ distance: 0, duration: 0, steps: [] }]
    for (const step of path.instructions || []) {
      const leg = legs[legs.length - 1]
      leg.distance += step.distance
      leg.duration += step.time / 1000
      if (step.street_name) leg.steps.push({ name: step.street_name })
      if (step.sign === 5) legs.push({ distance: 0, duration: 0, steps: [] })
    }
    return c.json({ source: 'VIETMAP', distance: path.distance, duration: path.time / 1000, geometry: path.points, legs })
  } catch {
    return c.json({ message: 'VietMap is unavailable right now.' }, 502)
  }
})

export default app
