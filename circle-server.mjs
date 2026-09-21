import { existsSync } from 'node:fs'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import app from './server.js'

// Local development: serve the API and public/ from one origin, like Vercel does.
const local = new Hono()
// Mirror Vercel's cleanUrls: /payments.html redirects to /payments (and /index.html to /)...
local.use('*', async (c, next) => {
  const { pathname, search } = new URL(c.req.url)
  if (pathname.endsWith('.html')) return c.redirect((pathname === '/index.html' ? '/' : pathname.slice(0, -5)) + search, 308)
  await next()
})
// ...and /payments is served from public/payments.html. Static files come first, like Vercel's CDN.
local.use('/*', serveStatic({
  root: './public',
  rewriteRequestPath: (path) => (/^\/[\w-]+$/.test(path) && existsSync(`./public${path}.html`) ? `${path}.html` : path),
}))
local.route('/', app)

const port = Number(process.env.PORT) || 5173
serve({ fetch: local.fetch, port })
console.log(`Hedgora running on http://localhost:${port} (Circle ${process.env.CIRCLE_API_KEY ? 'configured' : 'waiting for CIRCLE_API_KEY'}; AI ${process.env.DEEPSEEK_API_KEY ? 'configured' : 'waiting for DEEPSEEK_API_KEY'})`)
