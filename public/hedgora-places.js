// Shared by the Explore and Trips pages: the traveler's location, real nearby places from OpenStreetMap
// (via Photon), matching Wikimedia Commons photos, saved places, the map, routing and the AI trip planner.
// Storage keys and formats match the homepage, so location, saved places, photos and plans carry over.
;(() => {
  const DEFAULT_LOCATION = { lat: 10.3467, lon: 107.0844, name: 'Vũng Tàu, Vietnam', shared: false }
  const LOCATION_KEY = 'hedgora.location'
  const SAVED_KEY = 'hedgora.saved'
  const PHOTO_CACHE_KEY = 'hedgora.photos'
  const PHOTO_TTL = 7 * 864e5
  const SIGHT_KINDS = ['Beach', 'Attraction', 'Viewpoint', 'Museum', 'Historic site']
  const PLACE_KINDS = { beach: 'Beach', attraction: 'Attraction', viewpoint: 'Viewpoint', museum: 'Museum', restaurant: 'Restaurant', cafe: 'Café', hotel: 'Hotel', guest_house: 'Guest house', hostel: 'Hostel' }
  // The same four searches as the homepage's "Discover nearby" (radius in km, up to 25 results each).
  const GROUPS = [
    { key: 'sight', label: 'Sights', tag: 'SIGHTSEEING', icon: '⛰', radius: 10, tags: ['natural:beach', 'tourism:attraction', 'tourism:viewpoint', 'tourism:museum', 'historic'] },
    { key: 'food', label: 'Food', tag: 'FOOD & DRINK', icon: '🍜', radius: 2, tags: ['amenity:restaurant'] },
    { key: 'cafe', label: 'Cafés', tag: 'CAFÉ', icon: '☕', radius: 2, tags: ['amenity:cafe'] },
    { key: 'stay', label: 'Stay', tag: 'STAY', icon: '🛏', radius: 3, tags: ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel'] },
  ]
  const ROUTE_MODES = {
    WALKING: { label: 'Walking', verb: 'on foot', endpoint: 'https://routing.openstreetmap.de/routed-foot/route/v1/driving' },
    DRIVING: { label: 'Driving', verb: 'by car', endpoint: 'https://router.project-osrm.org/route/v1/driving' },
    BICYCLING: { label: 'Bicycling', verb: 'by bike', endpoint: 'https://routing.openstreetmap.de/routed-bike/route/v1/driving' },
    TWO_WHEELER: { label: 'Motorbike', verb: 'by motorbike', endpoint: 'https://router.project-osrm.org/route/v1/driving' },
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
  async function reverseGeocode(lat, lon) {
    try {
      const r = await fetch('https://photon.komoot.io/reverse?' + new URLSearchParams({ lat, lon, limit: '1', lang: 'en' }))
      if (!r.ok) throw new Error('Photon request failed')
      const p = (await r.json()).features?.[0]?.properties || {}
      const parts = [...new Set([p.district || p.locality || p.name, p.city || p.county || p.state].filter(Boolean).map(String))]
      if (parts.length < 2 && p.country) parts.push(p.country)
      if (parts.length) return parts.join(', ')
    } catch {}
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?' + new URLSearchParams({ format: 'jsonv2', lat, lon, zoom: '14', 'accept-language': 'en' }))
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

  // Real named places from OpenStreetMap, closest first.
  async function photonNearby(group, origin) {
    const p = new URLSearchParams({ lat: origin.lat, lon: origin.lon, radius: group.radius, limit: '25', lang: 'default' })
    group.tags.forEach((t) => p.append('osm_tag', t))
    const r = await fetch('https://photon.komoot.io/reverse?' + p)
    if (!r.ok) throw new Error('Photon request failed')
    return ((await r.json()).features || []).map((f) => {
      const pr = f.properties || {}, [lon, lat] = f.geometry?.coordinates || []
      return {
        name: pr.name, lat, lon, group,
        kind: pr.osm_key === 'historic' ? 'Historic site' : (PLACE_KINDS[pr.osm_value] || 'Place'),
        address: [[pr.housenumber, pr.street].filter(Boolean).join(' '), pr.district || pr.city].filter(Boolean).join(', '),
        distance: haversine(origin, { lat, lon }),
      }
    }).filter((x) => x.name && Number.isFinite(x.lat) && Number.isFinite(x.lon))
  }
  // All groups are searched at once; one that fails just adds nothing. Duplicate names are dropped, as on the homepage.
  async function fetchNearby(origin) {
    const results = await Promise.allSettled(GROUPS.map((g) => photonNearby(g, origin)))
    if (results.every((r) => r.status === 'rejected')) throw new Error('Could not load nearby places right now.')
    const seen = new Set()
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => a.distance - b.distance).filter((p) => !seen.has(p.name) && seen.add(p.name))
  }

  // Only use a Commons photo whose title matches the place name AND was taken within 1 km of it.
  // Wikimedia asks clients to identify themselves and not to burst, so lookups run one at a time and are cached for a week.
  let photoQueue = Promise.resolve()
  function photoCache() { try { return JSON.parse(localStorage.getItem(PHOTO_CACHE_KEY) || '{}') } catch { return {} } }
  function cachePhoto(key, value) {
    try {
      const c = photoCache()
      c[key] = { v: value, t: Date.now() }
      const keys = Object.keys(c)
      if (keys.length > 200) keys.sort((a, b) => c[a].t - c[b].t).slice(0, keys.length - 200).forEach((k) => delete c[k])
      localStorage.setItem(PHOTO_CACHE_KEY, JSON.stringify(c))
    } catch {}
  }
  // Commons returns the author as HTML; parse it in an inert document so nothing in it can load or run.
  const htmlText = (h) => new DOMParser().parseFromString(String(h || ''), 'text/html').body.textContent.replace(/\s+/g, ' ').trim()
  function findPlacePhoto(place) {
    const key = place.name + '@' + Number(place.lat).toFixed(3) + ',' + Number(place.lon).toFixed(3), hit = photoCache()[key]
    if (hit && Date.now() - hit.t < PHOTO_TTL) return Promise.resolve(hit.v)
    const job = photoQueue.then(async () => {
      const p = new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: '3', gsrsearch: `${place.name} nearcoord:1km,${place.lat},${place.lon}`, prop: 'imageinfo', iiprop: 'url|extmetadata', iiextmetadatafilter: 'Artist|LicenseShortName', iiurlwidth: '700' })
      let photo = null
      try {
        const r = await fetch('https://commons.wikimedia.org/w/api.php?' + p, { headers: { 'Api-User-Agent': 'Hedgora/1.0 (https://www.hedgora.xyz)' } })
        if (r.ok) {
          const pages = Object.values((await r.json()).query?.pages || {}).sort((a, b) => a.index - b.index)
          const info = pages.map((x) => x.imageinfo?.[0]).find((i) => i?.thumburl && !/\.(pdf|svg|tiff?|webm|ogv)$/i.test(i.url || ''))
          if (info) {
            const meta = info.extmetadata || {}
            photo = { url: info.thumburl, page: info.descriptionurl, author: (htmlText(meta.Artist?.value) || 'Unknown author').slice(0, 60), license: htmlText(meta.LicenseShortName?.value) || 'see source' }
          }
          cachePhoto(key, photo)
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 350))
      return photo
    })
    photoQueue = job.catch(() => null)
    return job
  }
  // CC BY / BY-SA photos must credit the author and license; the link goes to the file page on Commons.
  const photoCredit = (photo, className = 'photo-credit') => `<a class="${className}" href="${escapeHtml(photo.page)}" target="_blank" rel="noreferrer" title="Photo by ${escapeHtml(photo.author)} · ${escapeHtml(photo.license)} · Wikimedia Commons">📷 ${escapeHtml(photo.author)} · ${escapeHtml(photo.license)}</a>`

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
    const coords = points.map((p) => `${p.lon},${p.lat}`).join(';')
    const r = await fetch(`${mode.endpoint}/${coords}?overview=full&geometries=geojson&steps=true`)
    const data = await r.json()
    if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route')
    return data.routes[0]
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
    loadLocation, locate, fetchNearby, findPlacePhoto, photoCredit,
    placeKey, savedPlaces, isSaved, toggleSaved, popHeart,
    createMap, route, drawRoute, planTitle, planTrip,
  }
})()
