// Hedgora API. Vercel runs this file as a function (framework preset "hono");
// locally, circle-server.mjs serves it together with public/.
import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { stream } from 'hono/streaming'
import OpenAI from 'openai'
import { initiateUserControlledWalletsClient } from '@circle-fin/user-controlled-wallets'

const apiKey = process.env.CIRCLE_API_KEY
const client = apiKey ? initiateUserControlledWalletsClient({ apiKey }) : null
// Arc mainnet, where USDC is real money. Set CIRCLE_BLOCKCHAIN=ARC-TESTNET (with a TEST_API_KEY) to work on the
// test network instead; pages follow whatever this says, through /api/health.
const testnet = process.env.CIRCLE_BLOCKCHAIN === 'ARC-TESTNET'
const NETWORK = {
  blockchain: testnet ? 'ARC-TESTNET' : 'ARC',
  name: testnet ? 'Arc Testnet' : 'Arc',
  testnet,
  explorer: testnet ? 'https://explorer.testnet.arc.io' : 'https://explorer.arc.io',
}
// A test key cannot touch mainnet and a live key cannot touch the test network, and Circle's error for that is
// hard to read, so the mismatch is caught here instead.
const keyMatchesNetwork = !apiKey || apiKey.startsWith(testnet ? 'TEST_API_KEY' : 'LIVE_API_KEY')
if (apiKey && !keyMatchesNetwork) console.error(`CIRCLE_API_KEY is a ${testnet ? 'live' : 'test'} key but Hedgora is set to ${NETWORK.name}. Wallet features are switched off until they match.`)
// DeepSeek's API is OpenAI-compatible; DeepSeek recommends the OpenAI SDK pointed at its base URL.
const deepseek = process.env.DEEPSEEK_API_KEY ? new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY }) : null
// VietMap covers Vietnam only (Vietnamese addresses, car and motorbike routes); outside it the pages use Photon and OSRM.
const vietmapKey = process.env.VIETMAP_API_KEY
// SerpApi reads Google Maps listings: opening hours, photos and prices that OpenStreetMap doesn't have.
const serpKey = process.env.SERPAPI_API_KEY
// Viator (Tripadvisor) sells tours and tickets; its affiliate API gives "from" prices and booking links.
const viatorKey = process.env.VIATOR_API_KEY
const app = new Hono()

function unavailable(c) {
  if (apiKey && !keyMatchesNetwork) return c.json({ message: `The Circle API key on the backend is for the other environment, so ${NETWORK.name} wallets are unavailable.` }, 503)
  return c.json({ message: 'CIRCLE_API_KEY is not configured on the Circle backend.' }, 503)
}

// Headers every response carries. The full content policy would need the inline scripts these pages use, so it is
// sent in report-only mode for now; the part that blocks other sites from framing Hedgora is enforced.
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https://*.circle.com https://*.googleapis.com https://api.open-meteo.com https://photon.komoot.io https://nominatim.openstreetmap.org https://overpass-api.de https://overpass.private.coffee https://commons.wikimedia.org https://*.wikipedia.org https://api.openverse.org https://router.project-osrm.org https://routing.openstreetmap.de https://open.er-api.com",
  "frame-src https://*.circle.com https://accounts.google.com",
].join('; ')
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  // Geolocation is the traveler's location; nothing here needs a camera or a microphone.
  c.header('Permissions-Policy', 'camera=(), microphone=(), payment=(), geolocation=(self)')
  c.header('Content-Security-Policy', "frame-ancestors 'none'")
  c.header('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY)
})

// Circle bills per API call and per active wallet, so the wallet endpoints are limited per IP like the rest.
// Creating a payment is rarer than reading, and is limited harder.
const walletRateLimited = rateLimiter(30)
const transferRateLimited = rateLimiter(10)
function walletGuard(c, sending = false) {
  if (walletRateLimited(c) || (sending && transferRateLimited(c))) return c.json({ message: 'Too many requests. Please wait a minute and try again.' }, 429)
  return null
}

// On Vercel the Hono function is deployed as the "index" route, which shadows public/index.html at "/",
// so the function serves the homepage itself (locally, circle-server.mjs serves public/ first).
// Reading it via import.meta.url lets Vercel trace the file into the function bundle.
const homepage = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8')
app.get('/', (c) => c.html(homepage))

app.get('/api/health', (c) => c.json({ ok: true, configured: Boolean(client) && keyMatchesNetwork, ai: Boolean(deepseek), map: Boolean(vietmapKey), places: Boolean(serpKey), tours: Boolean(viatorKey), network: NETWORK }))

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
  if (!client || !keyMatchesNetwork) return unavailable(c)
  const blocked = walletGuard(c)
  if (blocked) return blocked
  try {
    const { deviceId } = await c.req.json()
    const { data } = await client.createDeviceTokenForSocialLogin({ deviceId })
    return c.json(data)
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/user/initialize', async (c) => {
  if (!apiKey || !keyMatchesNetwork) return unavailable(c)
  const blocked = walletGuard(c)
  if (blocked) return blocked
  try {
    const { userToken } = await c.req.json()
    const { status, body } = await circleRequest('/v1/w3s/user/initialize', {
      userToken,
      body: {
        idempotencyKey: crypto.randomUUID(),
        accountType: 'SCA',
        blockchains: [NETWORK.blockchain],
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
  if (!client || !keyMatchesNetwork) return unavailable(c)
  const blocked = walletGuard(c)
  if (blocked) return blocked
  try {
    const { userToken } = await c.req.json()
    const { data } = await client.listWallets({ userToken })
    return c.json(data)
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

app.post('/api/wallets/balances', async (c) => {
  if (!client || !keyMatchesNetwork) return unavailable(c)
  const blocked = walletGuard(c)
  if (blocked) return blocked
  try {
    const { userToken, walletId } = await c.req.json()
    const { data } = await client.getWalletTokenBalance({ userToken, walletId })
    return c.json(data)
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

// USDC is Arc's native gas token; Circle accepts its ERC-20 interface address for transfers (6 decimals).
// The address is the same on the test network and on mainnet.
const ARC_USDC = { tokenAddress: '0x3600000000000000000000000000000000000000', blockchain: NETWORK.blockchain }
const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value ?? ''))
const isAmount = (value) => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(String(value ?? '')) && Number(value) > 0

// Pass Circle's 4xx errors (e.g. 155208 "execution reverted" on an empty wallet) through with their message.
function circleError(c, error) {
  const status = error?.status ?? error?.response?.status
  return c.json({ message: error instanceof Error ? error.message : String(error), code: error?.code }, status >= 400 && status < 500 ? status : 502)
}

app.post('/api/transactions/list', async (c) => {
  if (!client || !keyMatchesNetwork) return unavailable(c)
  const blocked = walletGuard(c)
  if (blocked) return blocked
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
  if (!client || !keyMatchesNetwork) return unavailable(c)
  const blocked = walletGuard(c)
  if (blocked) return blocked
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
  if (!client || !keyMatchesNetwork) return unavailable(c)
  const blocked = walletGuard(c, true)
  if (blocked) return blocked
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

The app can prepare USDC payments on ${NETWORK.name}, but only the traveler can approve them. You cannot book or pay for anything yourself, so never say that something is booked or paid.

Reply in the traveler's language (Vietnamese if they write in Vietnamese). Keep answers short and practical: a sentence of context, then at most five suggestions or steps. Write plain text without Markdown headings, bold, or tables; start list items with "• ". For a plan, give each stop a time based on the local time and distances.

The traveler can only type text here: there is no photo upload, and each question is answered on its own without memory of earlier ones. So don't end with a follow-up question, and if a request needs something you don't have, such as the dishes on a menu to translate, ask them to type it in their next question.`

// Small in-memory per-IP limits so the public endpoints can't run up the DeepSeek, VietMap or SerpApi bills.
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

// Named places near a spot from OpenStreetMap: the four searches every page shows (sights within 10 km, restaurants
// and cafés within 2 km, places to stay within 3 km, up to 25 each). Browsers used to ask Photon directly, so a slow
// or throttled Photon left pages waiting with no end. Here each Photon search gives up after 5 seconds, Overpass
// answers if Photon can't, and answers are cached per spot on this instance and on Vercel's CDN, so travellers near
// each other share one lookup. Pages round the spot to about 500 m and measure distances from where you really are.
const NEARBY_GROUPS = [
  { key: 'sight', radius: 10, tags: ['natural:beach', 'tourism:attraction', 'tourism:viewpoint', 'tourism:museum', 'historic'] },
  { key: 'food', radius: 2, tags: ['amenity:restaurant'] },
  { key: 'cafe', radius: 2, tags: ['amenity:cafe'] },
  { key: 'stay', radius: 3, tags: ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel'] },
]
const PLACE_KINDS = { beach: 'Beach', attraction: 'Attraction', viewpoint: 'Viewpoint', museum: 'Museum', restaurant: 'Restaurant', cafe: 'Café', hotel: 'Hotel', guest_house: 'Guest house', hostel: 'Hostel' }
const OSM_HEADERS = { 'User-Agent': 'Hedgora/1.0 (https://www.hedgora.xyz)', Accept: 'application/json' }
const nearbyRateLimited = rateLimiter(30)
async function photonGroup(group, lat, lon) {
  const p = new URLSearchParams({ lat, lon, radius: group.radius, limit: '25', lang: 'default' })
  group.tags.forEach((t) => p.append('osm_tag', t))
  const r = await fetch('https://photon.komoot.io/reverse?' + p, { headers: OSM_HEADERS, signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error('Photon request failed (' + r.status + ')')
  return ((await r.json()).features || []).map((f) => {
    const pr = f.properties || {}, [plon, plat] = f.geometry?.coordinates || []
    return {
      name: pr.name, lat: plat, lon: plon, group: group.key,
      kind: pr.osm_key === 'historic' ? 'Historic site' : PLACE_KINDS[pr.osm_value] || 'Place',
      address: [[pr.housenumber, pr.street].filter(Boolean).join(' '), pr.district || pr.city].filter(Boolean).join(', '),
    }
  })
}
async function overpassNearby(lat, lon) {
  const around = (km) => `(around:${km * 1000},${lat},${lon})["name"]`
  const query = `[out:json][timeout:8];(nwr${around(10)}["tourism"~"^(attraction|viewpoint|museum)$"];nwr${around(10)}["natural"="beach"];nwr${around(10)}["historic"];nwr${around(2)}["amenity"~"^(restaurant|cafe)$"];nwr${around(3)}["tourism"~"^(hotel|guest_house|hostel)$"];);out center tags 600;`
  // Both public Overpass servers are asked at once; the first good answer wins and the other is cancelled.
  const controller = new AbortController()
  const ask = async (endpoint) => {
    const r = await fetch(endpoint, { method: 'POST', headers: { ...OSM_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: query }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) })
    if (!r.ok) throw new Error('Overpass request failed (' + r.status + ')')
    return (await r.json()).elements || []
  }
  const elements = await Promise.any(['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'].map(ask)).finally(() => controller.abort())
  const places = elements.map((e) => {
    const t = e.tags || {}
    const group = t.amenity === 'restaurant' ? 'food' : t.amenity === 'cafe' ? 'cafe' : /^(hotel|guest_house|hostel)$/.test(t.tourism) ? 'stay' : 'sight'
    const kind = t.natural === 'beach' ? 'Beach' : PLACE_KINDS[t.amenity] || PLACE_KINDS[t.tourism] || (t.historic ? 'Historic site' : 'Place')
    return { name: t.name, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, group, kind, address: [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:district'] || t['addr:city']].filter(Boolean).join(', ') }
  })
  // Like Photon: the 25 closest of each kind.
  return NEARBY_GROUPS.flatMap((g) => places.filter((p) => p.group === g.key && Number.isFinite(p.lat)).sort((a, b) => metres({ lat, lon }, a) - metres({ lat, lon }, b)).slice(0, 25))
}
app.get('/api/places/nearby', async (c) => {
  if (nearbyRateLimited(c)) return c.json({ message: 'Too many requests. Please wait a minute and try again.' }, 429)
  const lat = Number(c.req.query('lat')), lon = Number(c.req.query('lon'))
  if (!String(c.req.query('lat') ?? '').trim() || !String(c.req.query('lon') ?? '').trim() || !isLat(lat) || !isLon(lon)) return c.json({ message: 'Send lat and lon.' }, 400)
  const key = `n:${lat.toFixed(3)},${lon.toFixed(3)}`
  let answer = cacheGet(key, 12 * 3600_000)
  if (!answer) {
    const results = await Promise.allSettled(NEARBY_GROUPS.map((g) => photonGroup(g, lat, lon)))
    let places = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])), source = 'photon'
    if (results.every((r) => r.status === 'rejected')) {
      try { places = await overpassNearby(lat, lon); source = 'overpass' } catch (error) {
        console.error('Nearby places failed:', results[0].reason, error)
        return c.json({ message: 'Could not load nearby places right now.' }, 502)
      }
    }
    places = places.filter((p) => p.name && Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p) => ({ ...p, name: clip(p.name, 120), address: clip(p.address, 160) }))
    // Only a complete answer is kept; one with a missing search is tried again next time.
    answer = { source, places, fetchedAt: Date.now() }
    if (source === 'overpass' || results.every((r) => r.status === 'fulfilled')) cacheSet(key, answer)
    else return c.json(answer)
  }
  // Browsers keep it for 10 minutes; Vercel's CDN for 12 hours, then serves it stale while it refreshes.
  c.header('Cache-Control', 'public, max-age=600, s-maxage=43200, stale-while-revalidate=604800')
  return c.json(answer)
})

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

// Place details from Google Maps through SerpApi: opening hours, photos and a price when Google lists one.
// Each call spends a search from a small monthly plan, so pages only ask when the traveler taps Details,
// and answers are cached here (per server instance) and in the browser.
const placesRateLimited = rateLimiter(10)
const placeCache = new Map()
function cacheGet(key, ttl) {
  const hit = placeCache.get(key)
  if (hit && Date.now() - hit.fetchedAt < ttl) return hit
  placeCache.delete(key)
  return null
}
function cacheSet(key, value) {
  placeCache.set(key, value)
  if (placeCache.size > 500) placeCache.delete(placeCache.keys().next().value)
  return value
}
function placesGuard(c) {
  if (!serpKey) return c.json({ message: 'SERPAPI_API_KEY is not configured on the backend.' }, 503)
  if (placesRateLimited(c)) return c.json({ message: 'Too many requests. Please wait a minute and try again.' }, 429)
  return null
}
async function serpSearch(params) {
  const r = await fetch('https://serpapi.com/search.json?' + new URLSearchParams({ ...params, hl: 'vi', gl: 'vn', api_key: serpKey }))
  const data = await r.json().catch(() => ({}))
  // "No results" is an answer; a bad key or a used-up plan is not.
  if (data.error && !/hasn't returned any results/i.test(data.error)) throw Object.assign(new Error(data.error), { status: r.status })
  return data
}
function serpFailure(c, error) {
  console.error('SerpApi request failed:', error)
  const quota = /run out of searches|exhausted|throughput/i.test(error?.message || '')
  return c.json({ message: quota ? 'Google Maps details are used up for this month.' : 'Google Maps details are unavailable right now.' }, quota ? 503 : 502)
}

// Searching in Vietnamese keeps Vietnamese names as they are on OpenStreetMap; in English Google translates
// them ("Cơm tấm 67" becomes "Broken Rice 67"). Accents and words that only say what a place is are ignored.
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
const GENERIC_WORDS = new Set(['quan', 'nha', 'hang', 'restaurant', 'cafe', 'ca', 'phe', 'coffee', 'hotel', 'khach', 'san', 'nghi', 'hostel', 'homestay', 'resort', 'the', 'and', 'va'])
const nameWords = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w && !GENERIC_WORDS.has(w))
function sameName(a, b) {
  const wa = nameWords(a), wb = nameWords(b)
  if (!wa.length || !wb.length) return false
  const ja = ` ${wa.join(' ')} `, jb = ` ${wb.join(' ')} `
  if (ja.includes(jb) || jb.includes(ja)) return true
  const shared = wa.filter((w) => wb.includes(w)).length
  return shared >= 2 && shared / wa.length >= 0.6
}
function metres(a, b) {
  const R = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

const DAYS = { 'thu hai': 'monday', 'thu ba': 'tuesday', 'thu tu': 'wednesday', 'thu nam': 'thursday', 'thu sau': 'friday', 'thu bay': 'saturday', 'chu nhat': 'sunday' }
const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
// Google gives either { "thứ hai": "07:00–21:00", … } or [{ "thứ hai": "07:00–21:00" }, …]; times stay as given.
function weekHours(raw) {
  const entries = Array.isArray(raw) ? raw.flatMap((o) => Object.entries(o || {})) : raw && typeof raw === 'object' ? Object.entries(raw) : []
  const byDay = new Map()
  for (const [key, value] of entries) {
    const day = DAYS[fold(key).trim()] || (DAY_ORDER.includes(key) ? key : null)
    const text = fold(value)
    if (day) byDay.set(day, /ca ngay|24 gio/.test(text) ? 'Open 24 hours' : /^dong cua$/.test(text.trim()) ? 'Closed' : clip(value, 60))
  }
  return DAY_ORDER.filter((d) => byDay.has(d)).map((day) => ({ day, hours: byDay.get(day) }))
}
const httpsUrl = (u) => (/^https:\/\//.test(String(u || '')) ? String(u) : null)
// Google photo URLs end in a size such as "=w1000-h1000-c-n"; ask for a cropped 4:3 thumbnail and a large view.
function googlePhoto(thumbnail, image = thumbnail) {
  const resize = (url, size) => httpsUrl(url)?.replace(/=w\d+-h\d+[^/=]*$/, size)
  const photo = { thumbnail: resize(thumbnail, '=w400-h300-c'), image: resize(image, '=w1600-h1600-k-no') }
  return photo.thumbnail && photo.image ? photo : null
}

// Google Maps has no ticket prices, but visitors often write them in reviews ("Giá vé là 100.000 VND cho người
// lớn", "vé vào cửa 100k"). A mention counts when a ticket word comes shortly before the amount and the text
// isn't about parking or food. They are the reviewers' words, so pages quote them with the review's date.
const TICKET_WORD = /(?<!\p{L})(vé|phí vào cửa|phí tham quan|tickets?|entrance|entry fee|admission)(?!\p{L})/iu
const NOT_ADMISSION = /gửi xe|giữ xe|đỗ xe|đậu xe|parking|nước|đồ ăn|ăn uống|food|drink/iu
const VND_AMOUNT = /(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+|\d{1,4})\s*(k|nghìn|ngàn|đồng|đ|₫|vnđ|vnd)(?!\p{L})/giu
const FREE_ENTRY = /(miễn phí|không mất phí|không thu phí|free)[^.!?]{0,20}(vé|vào cửa|entry|admission)|(vé|vào cửa|entry|admission)[^.!?]{0,20}(miễn phí|free)/iu
function ticketMentions(reviews) {
  const quoteAround = (text, from, to) => {
    const start = Math.max(0, from - 70), end = Math.min(text.length, to + 50)
    let snippet = text.slice(start, end)
    if (start) snippet = '…' + snippet.replace(/^\S*\s/, '')
    if (end < text.length) snippet = snippet.replace(/\s\S*$/, '') + '…'
    return clip(snippet, 200)
  }
  const found = []
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const text = String(review?.description || '').replace(/\s+/g, ' ')
    const mention = (vnd, from, to) => found.push({ vnd, quote: quoteAround(text, from, to), date: /^\d{4}-\d{2}/.test(review.date_iso8601 || '') ? review.date_iso8601 : null, link: httpsUrl(review.link) })
    const amount = [...text.matchAll(VND_AMOUNT)].find((m) => {
      const before = text.slice(Math.max(0, m.index - 50), m.index), around = before.slice(-25) + m[0] + text.slice(m.index + m[0].length, m.index + m[0].length + 15)
      return TICKET_WORD.test(before) && !NOT_ADMISSION.test(around)
    })
    if (amount) {
      const n = Number(amount[1].replace(/[.,]/g, '')), vnd = ['k', 'nghìn', 'ngàn'].includes(amount[2].toLowerCase()) ? n * 1000 : n
      if (vnd >= 5000 && vnd <= 5_000_000) mention(vnd, amount.index, amount.index + amount[0].length)
      continue
    }
    const free = text.match(FREE_ENTRY)
    if (free && !NOT_ADMISSION.test(free[0])) mention(0, free.index, free.index + free[0].length)
  }
  // Newest first, one quote per amount.
  const seen = new Set()
  return found
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .filter((t) => !seen.has(t.vnd) && seen.add(t.vnd))
    .slice(0, 3)
    .map(({ vnd, ...t }) => ({ ...t, price: vnd ? vnd.toLocaleString('vi-VN') + ' ₫' : 'Free' }))
}

// Finds the Google Maps listing for an OpenStreetMap place: same name, and close to where OSM puts it.
app.get('/api/places/details', async (c) => {
  const blocked = placesGuard(c)
  if (blocked) return blocked
  // Number('') is 0, so a missing coordinate would otherwise search off the coast of Africa.
  const coord = (v) => (String(v ?? '').trim() ? Number(v) : NaN)
  const name = clip(c.req.query('name'), 120).trim(), lat = coord(c.req.query('lat')), lon = coord(c.req.query('lon'))
  if (!name || !isLat(lat) || !isLon(lon)) return c.json({ message: 'Send a place name, lat and lon.' }, 400)
  // Beaches and sights are large, so OSM and Google can put them far apart; shops sit within a street or two.
  const kind = c.req.query('kind'), sight = ['Beach', 'Attraction', 'Viewpoint', 'Historic site', 'Museum'].includes(kind)
  const radius = sight && kind !== 'Museum' ? 2000 : 400
  const key = `d:${fold(name)}@${lat.toFixed(3)},${lon.toFixed(3)}`
  const hit = cacheGet(key, 24 * 3600_000)
  if (hit) return c.json(hit)
  try {
    // The area name keeps Google from answering with a same-named place in another city or country.
    const near = clip(c.req.query('near'), 120).trim()
    const data = await serpSearch({ engine: 'google_maps', type: 'search', q: near ? `${name}, ${near}` : name, ll: `@${lat},${lon},16z` })
    const listings = data.place_results ? [data.place_results] : Array.isArray(data.local_results) ? data.local_results : []
    const place = listings
      .map((x) => ({ x, d: metres({ lat, lon }, { lat: x.gps_coordinates?.latitude, lon: x.gps_coordinates?.longitude }) }))
      .filter(({ x, d }) => d <= radius && sameName(name, x.title))
      .sort((a, b) => a.d - b.d)[0]?.x
    if (!place) return c.json(cacheSet(key, { found: false, fetchedAt: Date.now() }))
    // Sights get the ticket prices visitors mention. A search list has no reviews, so that costs one more search.
    let tickets
    if (sight) {
      let reviews = place.user_reviews?.most_relevant
      if (!reviews && place.place_id) reviews = (await serpSearch({ engine: 'google_maps', place_id: place.place_id })).place_results?.user_reviews?.most_relevant
      tickets = ticketMentions(reviews)
    }
    return c.json(cacheSet(key, {
      found: true,
      name: clip(place.title, 120),
      address: clip(place.address, 200),
      mapsUrl: 'https://www.google.com/maps/search/?' + new URLSearchParams({ api: '1', query: place.title, ...(place.place_id ? { query_place_id: place.place_id } : {}) }),
      price: clip(place.price, 40) || null,
      hours: weekHours(place.operating_hours || place.hours),
      photo: googlePhoto(place.thumbnail),
      photosId: /^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(place.data_id || '') ? place.data_id : null,
      tickets,
      fetchedAt: Date.now(),
    }))
  } catch (error) {
    return serpFailure(c, error)
  }
})

// Tours and tickets near a spot, from Viator's Basic-access affiliate API (/destinations and /products/search).
// The nearest Viator destination within 60 km is used; its 50 best-rated products are cached for a day, and the
// destination list for a day. With a sight's name, products whose title names it come first.
// Links are Viator's affiliate productUrl, so a booking made through them earns Hedgora a commission.
async function viator(path, body) {
  const r = await fetch('https://api.viator.com/partner' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'exp-api-key': viatorKey, Accept: 'application/json;version=2.0', 'Accept-Language': 'en-US', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.message || `Viator request failed (${r.status})`), { status: r.status })
  return data
}
async function nearestDestination(lat, lon) {
  let hit = cacheGet('v:destinations', 24 * 3600_000)
  if (!hit) {
    const { destinations = [] } = await viator('/destinations')
    // Countries, states and regions are too wide to say "tours near you".
    const list = destinations.filter((d) => Number.isFinite(d.center?.latitude) && Number.isFinite(d.center?.longitude) && !['COUNTRY', 'STATE', 'REGION', 'UNION TERRITORY'].includes(d.type))
      .map((d) => ({ id: d.destinationId, name: d.name, lat: d.center.latitude, lon: d.center.longitude }))
    hit = cacheSet('v:destinations', { list, fetchedAt: Date.now() })
  }
  const best = hit.list.map((d) => ({ d, m: metres({ lat, lon }, d) })).sort((a, b) => a.m - b.m)[0]
  return best && best.m <= 60_000 ? best.d : null
}
async function destinationProducts(id) {
  const key = `v:products:${id}`, hit = cacheGet(key, 24 * 3600_000)
  if (hit) return hit.products
  // Up to 100 products (two pages of 50), so small sights still have a chance to be named.
  const search = (start) => viator('/products/search', { filtering: { destination: String(id) }, sorting: { sort: 'TRAVELER_RATING', order: 'DESCENDING' }, pagination: { start, count: 50 }, currency: 'VND' })
  const first = await search(1)
  const products = [...(first.products || []), ...(first.totalCount > 50 ? (await search(51)).products || [] : [])]
  const list = products.filter((p) => httpsUrl(p.productUrl) && Number.isFinite(p.pricing?.summary?.fromPrice)).map((p) => {
    const cover = (p.images || []).find((i) => i.isCover) || p.images?.[0]
    const image = (cover?.variants || []).filter((v) => v.width >= 300).sort((a, b) => a.width - b.width)[0]
    return {
      title: clip(p.title, 160),
      fromPrice: Math.round(p.pricing.summary.fromPrice),
      url: p.productUrl,
      rating: Number.isFinite(p.reviews?.combinedAverageRating) ? Math.round(p.reviews.combinedAverageRating * 10) / 10 : null,
      reviews: p.reviews?.totalReviews || 0,
      image: httpsUrl(image?.url),
      minutes: p.duration?.fixedDurationInMinutes || p.duration?.variableDurationFromMinutes || null,
    }
  })
  return cacheSet(key, { products: list, fetchedAt: Date.now() }).products
}
app.get('/api/tours', async (c) => {
  if (!viatorKey) return c.json({ message: 'VIATOR_API_KEY is not configured on the backend.' }, 503)
  if (placesRateLimited(c)) return c.json({ message: 'Too many requests. Please wait a minute and try again.' }, 429)
  const lat = Number(c.req.query('lat')), lon = Number(c.req.query('lon'))
  if (!String(c.req.query('lat') ?? '').trim() || !isLat(lat) || !isLon(lon)) return c.json({ message: 'Send lat and lon.' }, 400)
  try {
    const destination = await nearestDestination(lat, lon)
    if (!destination) return c.json({ destination: null, matched: [], popular: [] })
    const products = await destinationProducts(destination.id)
    // "Bảo tàng Vũ khí cổ Robert Taylor" matches "… Robert Taylor Museum …": at least two of the name's own words
    // (or its only one), ignoring the destination's name and words that say what kind of place it is.
    const skip = new Set([...nameWords(destination.name), 'bao', 'tang', 'tuong', 'chua', 'den', 'dinh', 'nha', 'tho', 'bai', 'nui', 'ho', 'cong', 'vien', 'khu', 'du', 'lich', 'di', 'tich'])
    const own = nameWords(clip(c.req.query('name'), 120)).filter((w) => !skip.has(w) && w.length > 1)
    // Viator also files cruise shore excursions (Phu My port to Saigon, for Vũng Tàu) and airport transfers under
    // a destination; someone already here wants things to do here.
    const local = products.filter((p) => !/transfer|airport|shore excursion|cruise|\bport\b/i.test(p.title))
    const matched = own.length ? local.filter((p) => { const t = new Set(nameWords(p.title)); return own.filter((w) => t.has(w)).length >= Math.min(2, own.length) }).slice(0, 3) : []
    // Otherwise the most reviewed products named after the destination ("… in Vung Tau").
    const destinationWords = nameWords(destination.name)
    const popular = local.filter((p) => !matched.includes(p) && destinationWords.every((w) => nameWords(p.title).includes(w))).sort((a, b) => b.reviews - a.reviews).slice(0, 3)
    return c.json({ destination: { name: destination.name }, matched, popular })
  } catch (error) {
    console.error('Viator request failed:', error)
    const status = error?.status
    return c.json({ message: status === 401 || status === 403 ? 'The Viator API key on the backend is invalid or lacks access.' : 'Viator is unavailable right now.' }, 502)
  }
})

// More photos of a listing found above (its data_id), at a size that suits the page.
app.get('/api/places/photos', async (c) => {
  const blocked = placesGuard(c)
  if (blocked) return blocked
  const id = String(c.req.query('id') || '')
  if (!/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(id)) return c.json({ message: 'Invalid place id.' }, 400)
  const key = `p:${id}`
  const hit = cacheGet(key, 7 * 24 * 3600_000)
  if (hit) return c.json(hit)
  try {
    const data = await serpSearch({ engine: 'google_maps_photos', data_id: id })
    const photos = (Array.isArray(data.photos) ? data.photos : []).map((p) => googlePhoto(p.thumbnail, p.image)).filter(Boolean).slice(0, 12)
    return c.json(cacheSet(key, { photos, fetchedAt: Date.now() }))
  } catch (error) {
    return serpFailure(c, error)
  }
})

export default app
