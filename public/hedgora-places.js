// Shared by the Explore and Trips pages: the traveler's location, real nearby places from OpenStreetMap
// (via Photon), photos from Wikimedia Commons and Openverse, saved places, the map, routing and the AI trip planner.
// The homepage uses the photos from here too; other storage keys and formats match it, so location, saved places
// and plans carry over.
;(() => {
  const DEFAULT_LOCATION = { lat: 10.3467, lon: 107.0844, name: 'Vũng Tàu, Vietnam', shared: false }
  const LOCATION_KEY = 'hedgora.location'
  const SAVED_KEY = 'hedgora.saved'
  const PHOTO_CACHE_KEY = 'hedgora.placePhotos'
  const AREA_KEY = 'hedgora.areaPhotos'
  const PHOTO_TTL = 7 * 864e5
  const GPLACES_KEY = 'hedgora.gplaces'
  const GPLACES_TTL = 3 * 864e5
  const CITY_KEY = 'hedgora.cityPhoto'
  const NEARBY_KEY = 'hedgora.nearby'
  const NEARBY_TTL = 6 * 3600e3
  // Gives up on a request after `ms` (older browsers without AbortSignal.timeout just wait).
  const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined)
  const SIGHT_KINDS = ['Beach', 'Attraction', 'Viewpoint', 'Museum', 'Historic site']
  const PLACE_KINDS = { beach: 'Beach', attraction: 'Attraction', viewpoint: 'Viewpoint', museum: 'Museum', restaurant: 'Restaurant', cafe: 'Café', hotel: 'Hotel', guest_house: 'Guest house', hostel: 'Hostel' }
  // The same four searches as the homepage's "Discover nearby" (radius in km, up to 25 results each).
  const GROUPS = [
    { key: 'sight', label: 'Sights', tag: 'SIGHTSEEING', icon: '⛰', radius: 10, tags: ['natural:beach', 'tourism:attraction', 'tourism:viewpoint', 'tourism:museum', 'historic'] },
    { key: 'food', label: 'Food', tag: 'FOOD & DRINK', icon: '🍜', radius: 2, tags: ['amenity:restaurant'] },
    { key: 'cafe', label: 'Cafés', tag: 'CAFÉ', icon: '☕', radius: 2, tags: ['amenity:cafe'] },
    { key: 'stay', label: 'Stay', tag: 'STAY', icon: '🛏', radius: 3, tags: ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel'] },
  ]
  // Car and motorbike routes come from VietMap (through Hedgora's server) inside Vietnam; walking, cycling and
  // anything VietMap can't route use the OSRM endpoints.
  const ROUTE_MODES = {
    WALKING: { label: 'Walking', verb: 'on foot', endpoint: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving' },
    DRIVING: { label: 'Driving', verb: 'by car', vehicle: 'car', endpoint: 'https://router.project-osrm.org/route/v1/driving' },
    BICYCLING: { label: 'Bicycling', verb: 'by bike', endpoint: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving' },
    TWO_WHEELER: { label: 'Motorbike', verb: 'by motorbike', vehicle: 'motorcycle', endpoint: 'https://router.project-osrm.org/route/v1/driving' },
  }
  const WEATHER_TEXT = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy rain showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail' }
  const apiBase = String(window.CIRCLE_CONFIG?.apiBase || '').replace(/\/$/, '')
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')

  const escapeHtml = (v) => String(v || '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]))
  const formatDistance = (m) => (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km')
  const formatDuration = (s) => { const min = Math.max(1, Math.round(s / 60)); return min < 60 ? min + ' min' : Math.floor(min / 60) + ' h ' + String(min % 60).padStart(2, '0') + ' min' }
  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(s))
  }
  let toastTimer
  function toast(text) {
    const el = document.getElementById('toast')
    if (!el) return
    el.textContent = text
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600)
  }

  // Location: central Vũng Tàu until the traveler shares theirs; a shared location is remembered for this tab only.
  function loadLocation() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(LOCATION_KEY) || 'null')
      if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lon)) return { lat: saved.lat, lon: saved.lon, name: String(saved.name || ''), shared: true }
    } catch {}
    return { ...DEFAULT_LOCATION }
  }
  function saveLocation(loc) {
    try { sessionStorage.setItem(LOCATION_KEY, JSON.stringify({ lat: loc.lat, lon: loc.lon, name: loc.name })) } catch {}
  }
  // Inside Vietnam, VietMap names the ward and city; elsewhere it has nothing and Photon (then Nominatim) is used.
  // Each service gets a few seconds, so a slow one can't hold up the page.
  async function reverseGeocode(lat, lon) {
    try {
      const r = await fetch(apiBase + '/api/map/reverse?' + new URLSearchParams({ lat, lon }), { signal: timeout(6000) })
      if (r.ok) { const { name } = await r.json(); if (name) return name }
    } catch {}
    try {
      const r = await fetch('https://photon.komoot.io/reverse?' + new URLSearchParams({ lat, lon, limit: '1', lang: 'en' }), { signal: timeout(6000) })
      if (!r.ok) throw new Error('Photon request failed')
      const p = (await r.json()).features?.[0]?.properties || {}
      const parts = [...new Set([p.district || p.locality || p.name, p.city || p.county || p.state].filter(Boolean).map(String))]
      if (parts.length < 2 && p.country) parts.push(p.country)
      if (parts.length) return parts.join(', ')
    } catch {}
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({ format: 'jsonv2', lat, lon, zoom: '14', 'accept-language': 'en' }), { signal: timeout(6000) })
    if (!r.ok) throw new Error('Reverse geocoding failed')
    const a = (await r.json()).address || {}
    return [...new Set([a.suburb || a.quarter || a.city_district, a.city || a.town || a.village || a.county || a.state].filter(Boolean).map(String))].join(', ') || a.country || ''
  }
  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Your browser does not support location'))
      navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords
        let name = lat.toFixed(4) + ', ' + lon.toFixed(4)
        try { name = (await reverseGeocode(lat, lon)) || name } catch {}
        const loc = { lat, lon, name, shared: true }
        saveLocation(loc)
        resolve(loc)
      }, (err) => reject(new Error(err.code === 1 ? 'Allow location access to update' : 'Couldn’t get your location. Please try again.')), { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
    })
  }

  // Real named places from OpenStreetMap, straight from Photon. Only used when Hedgora's server can't be reached.
  async function photonNearby(group, origin) {
    const p = new URLSearchParams({ lat: origin.lat, lon: origin.lon, radius: group.radius, limit: '25', lang: 'default' })
    group.tags.forEach((t) => p.append('osm_tag', t))
    const r = await fetch('https://photon.komoot.io/reverse?' + p, { signal: timeout(8000) })
    if (!r.ok) throw new Error('Photon request failed')
    return ((await r.json()).features || []).map((f) => {
      const pr = f.properties || {}, [lon, lat] = f.geometry?.coordinates || []
      return {
        name: pr.name, lat, lon, group: group.key,
        kind: pr.osm_key === 'historic' ? 'Historic site' : (PLACE_KINDS[pr.osm_value] || 'Place'),
        address: [[pr.housenumber, pr.street].filter(Boolean).join(' '), pr.district || pr.city].filter(Boolean).join(', '),
      }
    }).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lon))
  }
  // Nearby places come from Hedgora's server, which asks Photon (or Overpass when Photon can't answer) and caches
  // the answer per spot. The spot is rounded to about 500 m so nearby travellers share it; distances are measured
  // from where the traveler really is. Answers stay in this browser, shared by the homepage, Explore and Trips: for
  // 6 hours they're simply used, and for up to a week they're shown at once while a fresh copy loads for next time.
  // Photon is asked directly only when the server can't be reached at all. Closest first, duplicate names dropped.
  async function nearbyFromServer(spot, key) {
    let r
    try {
      r = await fetch(apiBase + '/api/places/nearby?' + new URLSearchParams(spot), { signal: timeout(20000) })
    } catch {
      const results = await Promise.allSettled(GROUPS.map((g) => photonNearby(g, { lat: Number(spot.lat), lon: Number(spot.lon) })))
      if (results.every((x) => x.status === 'rejected')) throw new Error('Could not load nearby places right now.')
      return results.flatMap((x) => (x.status === 'fulfilled' ? x.value : []))
    }
    const data = await r.json().catch(() => ({}))
    if (!r.ok || !Array.isArray(data.places)) throw new Error(data.message || 'Could not load nearby places right now.')
    writeStore(NEARBY_KEY, key, data.places, 8)
    return data.places
  }
  async function fetchNearby(origin) {
    const round = (v) => (Math.round(v / 0.005) * 0.005).toFixed(3)
    const spot = { lat: round(origin.lat), lon: round(origin.lon) }, key = spot.lat + ',' + spot.lon
    const hit = readStore(NEARBY_KEY)[key], age = hit ? Date.now() - hit.t : Infinity
    let places
    if (age < NEARBY_TTL) places = hit.v
    else if (age < 7 * 864e5) { places = hit.v; nearbyFromServer(spot, key).catch(() => {}) }
    else places = await nearbyFromServer(spot, key)
    const groups = Object.fromEntries(GROUPS.map((g) => [g.key, g])), seen = new Set()
    return places
      .map((p) => ({ ...p, group: groups[p.group] || GROUPS[0], distance: haversine(origin, p) }))
      .sort((a, b) => a.distance - b.distance)
      .filter((p) => !seen.has(p.name) && seen.add(p.name))
  }

  // Small browser caches shaped { key: { v: value, t: savedAt } }; past `max` entries the oldest are dropped.
  function readStore(name) { try { return JSON.parse(localStorage.getItem(name) || '{}') } catch { return {} } }
  function writeStore(name, key, value, max) {
    try {
      const c = readStore(name)
      c[key] = { v: value, t: Date.now() }
      const keys = Object.keys(c)
      if (keys.length > max) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - max).forEach((k) => delete c[k])
      localStorage.setItem(name, JSON.stringify(c))
    } catch {}
  }
  // Place photos, most specific first:
  // 1. Sights: a Wikimedia Commons photo whose title matches the name and was taken within 1 km, else an Openverse
  //    photo (openly licensed, from Flickr and other collections) whose title or tags name the sight and the city.
  // 2. Any place still without one: an area photo, the nearest geotagged Commons photo within 600 m (1 km for sights),
  //    each scene used once per page. Its credit says "Area photo" and how far away it was taken, so it's never
  //    passed off as the place itself.
  // Wikimedia asks clients to identify themselves and not to burst, and Openverse allows 20 anonymous searches a
  // minute and 200 a day, so each service's requests run one at a time (Openverse at most 18 in any minute), answers
  // are cached for a week, and a service that answers "too many requests" is left alone for a minute.
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
  function serialQueue(gap, perMinute = Infinity) {
    let tail = Promise.resolve(), pausedUntil = 0
    const starts = []
    const run = (task) => {
      const job = tail.then(async () => {
        if (Date.now() < pausedUntil) throw new Error('Paused after too many requests')
        while (starts.length && Date.now() - starts[0] >= 60_000) starts.shift()
        if (starts.length >= perMinute) { await sleep(starts[0] + 60_000 - Date.now()); starts.shift() }
        starts.push(Date.now())
        try { return await task() } finally { await sleep(gap) }
      })
      tail = job.catch(() => null)
      return job
    }
    run.pause = (ms) => { pausedUntil = Date.now() + ms }
    return run
  }
  const commonsQueue = serialQueue(350), openverseQueue = serialQueue(300, 18)
  function getJson(queue, url, options) {
    return queue(async () => {
      const r = await fetch(url, options)
      if (r.status === 429) { queue.pause(60_000); throw new Error('Too many requests') }
      if (!r.ok) throw new Error('Request failed (' + r.status + ')')
      return r.json()
    })
  }
  // The old cache only knew Commons, so its "no photo" answers would hide Openverse photos for a week.
  try { localStorage.removeItem('hedgora.photos') } catch {}

  const COMMONS_API = 'https://commons.wikimedia.org/w/api.php?'
  const COMMONS_HEADERS = { 'Api-User-Agent': 'Hedgora/1.0 (https://www.hedgora.xyz)' }
  const COMMONS_INFO = { action: 'query', format: 'json', origin: '*', prop: 'imageinfo', iiprop: 'url|extmetadata', iiextmetadatafilter: 'Artist|LicenseShortName', iiurlwidth: '700' }
  // Commons returns the author as HTML; parse it in an inert document so nothing in it can load or run.
  const htmlText = (h) => new DOMParser().parseFromString(String(h || ''), 'text/html').body.textContent.replace(/\s+/g, ' ').trim()
  function commonsPhoto(page) {
    const info = page?.imageinfo?.[0]
    if (!info?.thumburl || /\.(pdf|svg|tiff?|webm|ogv|gif)$/i.test(info.url || '')) return null
    const meta = info.extmetadata || {}
    // `scene` ignores numbers and punctuation, so "Temple.jpg" and "Temple (2).jpg" are one scene.
    return { url: info.thumburl, page: info.descriptionurl, author: (htmlText(meta.Artist?.value) || 'Unknown author').slice(0, 60), license: htmlText(meta.LicenseShortName?.value) || 'see source', source: 'Wikimedia Commons', scene: fold(page.title).replace(/[^a-z]+/g, '') }
  }
  async function commonsNamedPhoto(place) {
    const data = await getJson(commonsQueue, COMMONS_API + new URLSearchParams({ ...COMMONS_INFO, generator: 'search', gsrnamespace: '6', gsrlimit: '3', gsrsearch: `${place.name} nearcoord:1km,${place.lat},${place.lon}` }), { headers: COMMONS_HEADERS })
    return Object.values(data.query?.pages || {}).sort((a, b) => a.index - b.index).map(commonsPhoto).find(Boolean) || null
  }

  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
  const words = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean)
  // "Phường Thắng Tam, Thành Phố Vũng Tàu" → "Vũng Tàu"; "Vũng Tàu, Vietnam" → "Vũng Tàu".
  function cityOf(locationName) {
    const parts = String(locationName || '').split(',').map((s) => s.trim()).filter((s) => s && !/^(viet ?nam)$/.test(fold(s)) && !/^-?\d/.test(s))
    return (parts[parts.length - 1] || '').replace(/^(thành phố|tp\.?|tỉnh|thị xã|quận|huyện|phường|xã)\s+/i, '')
  }
  // Words that say what a sight is rather than which one it is ("Chùa", "Bãi", "Tượng"); a photo of another pagoda
  // in the same city must not count as a match.
  const TYPE_WORDS = new Set(['chua', 'den', 'dinh', 'mieu', 'nha', 'tho', 'tuong', 'bai', 'nui', 'ho', 'cong', 'vien', 'bao', 'tang', 'thap', 'hai', 'dang', 'khu', 'di', 'tich', 'lang', 'the', 'of', 'and', 'beach', 'temple', 'pagoda', 'church', 'museum', 'park', 'statue', 'lighthouse', 'mountain'])
  const OPENVERSE_LICENSES = { by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nd': 'CC BY-ND', cc0: 'CC0', pdm: 'Public domain' }
  // Only licenses that allow commercial use, since Hedgora takes payments.
  async function openversePhoto(place, city) {
    const cityWords = words(city), nameWords = words(place.name).filter((w) => !TYPE_WORDS.has(w) && !cityWords.includes(w))
    if (!cityWords.length || !nameWords.length) return null
    const data = await getJson(openverseQueue, 'https://api.openverse.org/v1/images/?' + new URLSearchParams({ q: `${place.name} ${city}`, license_type: 'commercial', page_size: '10' }))
    const hit = (data.results || []).find((x) => {
      const text = new Set(words(x.title + ' ' + (x.tags || []).map((t) => t.name).join(' ')))
      return x.thumbnail && cityWords.every((w) => text.has(w)) && nameWords.filter((w) => text.has(w)).length >= nameWords.length / 2
    })
    if (!hit) return null
    const license = (OPENVERSE_LICENSES[hit.license] || 'CC ' + String(hit.license).toUpperCase()) + (hit.license_version && !['cc0', 'pdm'].includes(hit.license) ? ' ' + hit.license_version : '')
    return { url: hit.thumbnail, page: hit.foreign_landing_url || hit.detail_url, author: String(hit.creator || 'Unknown author').slice(0, 60), license, source: 'Openverse' }
  }
  // A failed or paused lookup isn't cached, so it's tried again next time.
  async function ownPhoto(place, city) {
    const key = place.name + '@' + Number(place.lat).toFixed(3) + ',' + Number(place.lon).toFixed(3), hit = readStore(PHOTO_CACHE_KEY)[key]
    if (hit && Date.now() - hit.t < PHOTO_TTL) return hit.v
    let photo
    try { photo = (await commonsNamedPhoto(place)) || (await openversePhoto(place, city)) } catch { return null }
    writeStore(PHOTO_CACHE_KEY, key, photo, 200)
    return photo
  }

  // Area photos come in cells of about 550 m: one Commons request returns the 50 geotagged photos nearest the cell,
  // shared by every place in it. Maps, logos and the like are skipped; "(2)" copies of one scene count once.
  const areaCells = new Map(), areaPicks = new Map(), usedScenes = new Set()
  function areaCell(place) {
    const size = 0.005, lat = (Math.floor(place.lat / size) + 0.5) * size, lon = (Math.floor(place.lon / size) + 0.5) * size
    const key = lat.toFixed(4) + ',' + lon.toFixed(4), hit = readStore(AREA_KEY)[key]
    if (areaCells.has(key)) return areaCells.get(key)
    const job = hit && Date.now() - hit.t < PHOTO_TTL ? Promise.resolve(hit.v) : getJson(commonsQueue, COMMONS_API + new URLSearchParams({ ...COMMONS_INFO, prop: 'imageinfo|coordinates', colimit: 'max', generator: 'geosearch', ggscoord: lat + '|' + lon, ggsradius: '1500', ggslimit: '50', ggsnamespace: '6' }), { headers: COMMONS_HEADERS }).then((data) => {
      const photos = Object.values(data.query?.pages || {})
        .filter((pg) => pg.coordinates?.[0] && !/\b(map|ban do|logo|flag|coat of arms|seal|diagram|chart|plan)\b/.test(fold(pg.title)))
        .map((pg) => { const photo = commonsPhoto(pg); return photo && { ...photo, lat: pg.coordinates[0].lat, lon: pg.coordinates[0].lon } })
        .filter(Boolean)
      writeStore(AREA_KEY, key, photos, 12)
      return photos
    })
    areaCells.set(key, job)
    job.catch(() => areaCells.delete(key))
    return job
  }
  async function areaPhoto(place) {
    const key = placeKey(place)
    if (!areaPicks.has(key)) {
      const photos = await areaCell(place), limit = SIGHT_KINDS.includes(place.kind) ? 1000 : 600
      if (areaPicks.has(key)) return areaPicks.get(key)
      const best = photos.map((ph) => ({ ph, d: haversine(place, ph) })).filter(({ ph, d }) => d <= limit && !usedScenes.has(ph.scene)).sort((a, b) => a.d - b.d)[0]
      if (best) usedScenes.add(best.ph.scene)
      areaPicks.set(key, best ? { ...best.ph, area: true, distance: best.d } : null)
    }
    return areaPicks.get(key)
  }

  // `near` is the traveler's location name; its city narrows the Openverse search.
  async function findPlacePhoto(place, near) {
    if (SIGHT_KINDS.includes(place.kind)) {
      const own = await ownPhoto(place, cityOf(near))
      // A sight's own Commons photo shouldn't show up again as a neighbour's area photo.
      if (own?.scene) usedScenes.add(own.scene)
      if (own) return own
    }
    try { return await areaPhoto(place) } catch { return null }
  }
  // Openly licensed photos must credit the author and license; the link goes to the photo's own page.
  function photoCredit(photo, className = 'photo-credit') {
    const where = photo.area ? `Area photo, ${formatDistance(photo.distance)} away · ` : ''
    const via = photo.source === 'Openverse' ? 'via Openverse' : 'Wikimedia Commons'
    return `<a class="${className}" href="${escapeHtml(photo.page)}" target="_blank" rel="noreferrer" title="${where}Photo by ${escapeHtml(photo.author)} · ${escapeHtml(photo.license)} · ${via}">📷 ${where}${escapeHtml(photo.author)} · ${escapeHtml(photo.license)}</a>`
  }
  // Alt text: an area photo shows the neighbourhood, not the place.
  const photoAlt = (photo, place) => (photo.area ? 'Area near ' + place.name : place.name)

  // The picture of the traveler's city for the homepage: the lead image of its Wikipedia article (a skyline, a coast,
  // a landmark), from Vietnamese Wikipedia first when the name is Vietnamese. In Vietnam, VietMap says which city
  // that is (Hiệp Bình or Quận 1 → Thành Phố Hồ Chí Minh; Thắng Tam → Thành Phố Vũng Tàu); elsewhere it's the last
  // part of the location name ("Mitte, Berlin" → "Berlin"). An article only counts when its coordinates are within
  // 60 km, so a person or a same-named town elsewhere never shows up. Author and license come from Commons.
  // Answers, including "none", are cached for a week per city.
  async function locationCity(loc) {
    const spot = 'at:' + loc.lat.toFixed(2) + ',' + loc.lon.toFixed(2), known = readStore(CITY_KEY)[spot]
    if (known && Date.now() - known.t < PHOTO_TTL) return known.v
    let city
    try {
      const r = await fetch(apiBase + '/api/map/reverse?' + new URLSearchParams({ lat: loc.lat, lon: loc.lon }), { signal: timeout(6000) })
      if (r.ok) city = (await r.json()).city
    } catch {}
    if (!city) {
      const parts = String(loc.name || '').split(',').map((s) => s.trim()).filter((s) => s && !/^viet ?nam$/.test(fold(s)) && !/^-?\d/.test(s))
      city = parts[parts.length - 1]
    }
    if (city) writeStore(CITY_KEY, spot, city, 40)
    return city
  }
  async function cityPhoto(loc) {
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null
    const city = await locationCity(loc)
    if (!city) return null
    const key = fold(city) + '@' + loc.lat.toFixed(1) + ',' + loc.lon.toFixed(1), hit = readStore(CITY_KEY)[key]
    if (hit && Date.now() - hit.t < PHOTO_TTL) return hit.v
    for (const wiki of /[^\x00-\x7f]/.test(city) ? ['vi', 'en'] : ['en', 'vi']) {
      const found = await getJson(commonsQueue, `https://${wiki}.wikipedia.org/w/api.php?` + new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: city, gsrlimit: '5', gsrnamespace: '0', prop: 'coordinates|pageimages', piprop: 'name', redirects: '1' }), { headers: COMMONS_HEADERS })
      const article = Object.values(found.query?.pages || {}).sort((a, b) => a.index - b.index)
        .find((p) => p.pageimage && p.coordinates?.[0] && haversine(loc, { lat: p.coordinates[0].lat, lon: p.coordinates[0].lon }) < 60000)
      if (!article) continue
      const info = await getJson(commonsQueue, COMMONS_API + new URLSearchParams({ ...COMMONS_INFO, titles: 'File:' + article.pageimage, iiurlwidth: '1280' }), { headers: COMMONS_HEADERS })
      const photo = commonsPhoto(Object.values(info.query?.pages || {})[0])
      if (!photo) continue
      // "Vũng Tàu (thành phố)" → "Vũng Tàu"
      const value = { ...photo, city: article.title.replace(/\s*\([^)]*\)$/, '') }
      writeStore(CITY_KEY, key, value, 40)
      return value
    }
    writeStore(CITY_KEY, key, null, 40)
    return null
  }

  // Opening hours, photos and price from Google Maps, through Hedgora's server and SerpApi. Every lookup spends
  // a search from a small monthly plan, so they only run when the traveler taps Details and are kept for 3 days
  // (photos for 7), including "not on Google Maps".
  // Answers are also kept in memory for this page, in case the browser blocks localStorage.
  const lookups = new Map()
  const cachedValue = (key, ttl) => { const hit = lookups.get(key) || readStore(GPLACES_KEY)[key]; return hit && Date.now() - hit.t < ttl ? hit.v : null }
  async function cachedLookup(key, path, ttl) {
    const hit = cachedValue(key, ttl)
    if (hit) return hit
    const r = await fetch(apiBase + path)
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.message || 'Google Maps details are unavailable right now.')
    lookups.set(key, { v: data, t: Date.now() })
    writeStore(GPLACES_KEY, key, data, 150)
    return data
  }
  // `near` is the traveler's area, e.g. "Phường Thắng Tam, Thành Phố Vũng Tàu".
  const placeDetails = (p, near) => cachedLookup('d:' + placeKey(p), '/api/places/details?' + new URLSearchParams({ name: p.name, lat: p.lat, lon: p.lon, kind: p.kind || '', near: near || '' }), GPLACES_TTL)
  const placePhotos = (id) => cachedLookup('p:' + id, '/api/places/photos?' + new URLSearchParams({ id }), 7 * 864e5)
  const cachedPlaceDetails = (p) => cachedValue('d:' + placeKey(p), GPLACES_TTL)
  const cachedPlacePhotos = (id) => (id ? cachedValue('p:' + id, 7 * 864e5) : null)
  // Viator tours and tickets near a sight, cached for a day (Viator costs Hedgora nothing per call).
  const placeTours = (p) => cachedLookup('t:' + placeKey(p), '/api/tours?' + new URLSearchParams({ lat: p.lat, lon: p.lon, name: p.name }), 864e5)
  const cachedPlaceTours = (p) => cachedValue('t:' + placeKey(p), 864e5)
  // true/false from today's hours ("07:00–21:00", "07:00–14:00, 17:00–22:00"), null when they can't be read.
  // A range that ends after midnight keeps the place open into the next morning.
  const WEEK = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  function openNow(hours, now = new Date()) {
    const day = (offset) => (hours || []).find((h) => h.day === WEEK[(now.getDay() + 7 + offset) % 7])?.hours || ''
    const ranges = (text) => [...text.matchAll(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/g)].map((m) => [m[1] * 60 + +m[2], m[3] * 60 + +m[4]])
    const mins = now.getHours() * 60 + now.getMinutes(), today = day(0), todayRanges = ranges(today)
    if (today === 'Open 24 hours') return true
    if (todayRanges.some(([a, b]) => (b > a ? mins >= a && mins < b : mins >= a))) return true
    if (ranges(day(-1)).some(([a, b]) => b <= a && mins < b)) return true
    return todayRanges.length || today === 'Closed' ? false : null
  }
  const todayHours = (hours, now = new Date()) => (hours || []).find((h) => h.day === WEEK[now.getDay()])?.hours || ''

  // Saved places live in this browser (localStorage), in the same format as the homepage.
  const placeKey = (p) => p.name + '@' + Number(p.lat).toFixed(5) + ',' + Number(p.lon).toFixed(5)
  function savedPlaces() { try { const v = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } }
  function storeSaved(list) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)) } catch { toast('Couldn’t save on this browser') }
    window.dispatchEvent(new CustomEvent('hedgora:saved'))
  }
  const isSaved = (p) => savedPlaces().some((s) => placeKey(s) === placeKey(p))
  function toggleSaved(p) {
    const list = savedPlaces(), i = list.findIndex((s) => placeKey(s) === placeKey(p))
    if (i >= 0) { list.splice(i, 1); storeSaved(list); return false }
    list.unshift({ name: p.name, kind: p.kind || 'Place', address: p.address || '', lat: p.lat, lon: p.lon, savedAt: Date.now() })
    storeSaved(list.slice(0, 100))
    return true
  }
  function popHeart(el) {
    if (!reduceMotion.matches) el.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.3,1.6,.5,1)' })
  }

  // Map and routing: OpenStreetMap tiles in Leaflet, routes from the OSRM servers the homepage map uses.
  function createMap(el, origin) {
    if (!window.L) { el.innerHTML = '<p class="map-empty">The map could not be loaded.</p>'; return null }
    const map = L.map(el, { scrollWheelZoom: false }).setView([origin.lat, origin.lon], 14)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors' }).addTo(map)
    const originMarker = L.circleMarker([origin.lat, origin.lon], { radius: 8, color: '#08795a', weight: 3, fillColor: '#70efc0', fillOpacity: 1 }).addTo(map).bindPopup('Your location')
    return { map, originMarker }
  }
  async function route(points, modeKey = 'WALKING') {
    const mode = ROUTE_MODES[modeKey] || ROUTE_MODES.WALKING
    if (mode.vehicle) {
      try {
        const r = await fetch(apiBase + '/api/map/route?' + new URLSearchParams({ vehicle: mode.vehicle, points: points.map((p) => `${p.lat},${p.lon}`).join(';') }))
        if (r.ok) return await r.json()
      } catch {}
    }
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(';')
    const r = await fetch(`${mode.endpoint}/${coords}?overview=full&geometries=geojson&steps=true`)
    const data = await r.json()
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route')
    return { ...data.routes[0], source: 'OSRM' }
  }
  // The route line draws itself along the path, then drops the dash so zooming redraws it normally.
  function drawRoute(line) {
    const path = line.getElement?.() || line.getLayers?.()[0]?.getElement?.()
    if (!path?.getTotalLength || reduceMotion.matches) return
    const len = path.getTotalLength()
    path.style.strokeDasharray = len
    path.style.strokeDashoffset = len
    path.getBoundingClientRect()
    path.style.transition = 'stroke-dashoffset 1.6s cubic-bezier(.4,.1,.2,1)'
    path.style.strokeDashoffset = '0'
    path.addEventListener('transitionend', () => { path.style.transition = ''; path.style.strokeDasharray = ''; path.style.strokeDashoffset = '' }, { once: true })
  }

  async function weatherLine(loc) {
    try {
      const p = new URLSearchParams({ latitude: loc.lat, longitude: loc.lon, current: 'temperature_2m,weather_code', timezone: 'auto' })
      const r = await fetch('https://api.open-meteo.com/v1/forecast?' + p)
      if (!r.ok) throw new Error()
      const c = (await r.json()).current || {}
      return (Number.isFinite(c.temperature_2m) ? Math.round(c.temperature_2m) + '°' : '') + ' · ' + (WEATHER_TEXT[c.weather_code] || 'Current conditions')
    } catch { return 'Weather unavailable' }
  }
  function planTitle() {
    const h = new Date().getHours()
    return h < 11 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'
  }
  // Asks Hedgora AI for a plan. Stops come back as indexes into `places`, so every stop is one of these real places.
  async function planTrip(loc, places) {
    const now = new Date()
    const r = await fetch(apiBase + '/api/ai/itinerary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        location: { name: loc.name },
        localTime: now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }) + ' (' + Intl.DateTimeFormat().resolvedOptions().timeZone + ')',
        weather: await weatherLine(loc),
        places: places.map((p) => ({ name: p.name, kind: p.kind, distance: formatDistance(p.distance), address: p.address })),
      }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(data.message || 'Hedgora AI did not respond (' + r.status + ')')
    return data
  }

  // The Circle client calls this when a wallet connects or disconnects.
  window.hedgoraWallet = {
    setConnected(value, address) {
      const text = document.getElementById('walletText'), dot = document.querySelector('.status-dot')
      if (text) text.textContent = value ? (address && address.length > 12 ? address.slice(0, 6) + '…' + address.slice(-4) : 'Circle Wallet') : 'Get Start'
      if (dot) dot.style.background = value ? '#70efc0' : '#667d76'
    },
  }

  window.Hedgora = {
    GROUPS, SIGHT_KINDS, ROUTE_MODES, reduceMotion,
    escapeHtml, formatDistance, formatDuration, haversine, toast,
    loadLocation, locate, reverseGeocode, fetchNearby, findPlacePhoto, photoCredit, photoAlt, cityPhoto,
    placeDetails, placePhotos, cachedPlaceDetails, cachedPlacePhotos, placeTours, cachedPlaceTours, openNow, todayHours,
    placeKey, savedPlaces, isSaved, toggleSaved, popHeart,
    createMap, route, drawRoute, planTitle, planTrip,
  }
})()
