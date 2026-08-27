// Thin Upstash Redis wrapper — the Vercel-side KV client shared by the bug-report API and the
// menu-state (Publish) API. REST-based (fetch under the hood), so it works on the Edge runtime
// (no persistent TCP connection, unlike node-redis) — required since every api/*.mjs route in
// this project runs `export const config = { runtime: 'edge' }` to match the Web-standard
// Request/Response signature the Cloudflare Worker and Netlify Functions v2 already use.
//
// Provisioning note: the exact env var names Vercel's Upstash Marketplace integration injects can
// vary by how it was added (Vercel KV legacy naming vs. a raw Upstash integration) — this reads
// both so whichever the dashboard actually set just works. Confirm the real names once the
// integration is added and trim this to the single pair that's actually present if you want.
import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const redis = (url && token) ? new Redis({ url, token }) : null;

// every route checks this and returns 500 with a clear message rather than throwing halfway
// through a handler if the integration hasn't been provisioned yet.
export const storeReady = () => !!redis;
