import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import app from './server.js'

// Local development: serve the API and public/ from one origin, like Vercel does.
const local = new Hono()
local.route('/', app)
local.use('/*', serveStatic({ root: './public' }))

const port = Number(process.env.PORT) || 5173
serve({ fetch: local.fetch, port })
console.log(`Hedgora running on http://localhost:${port} (Circle ${process.env.CIRCLE_API_KEY ? 'configured' : 'waiting for CIRCLE_API_KEY'}; AI ${process.env.DEEPSEEK_API_KEY ? 'configured' : 'waiting for DEEPSEEK_API_KEY'})`)
