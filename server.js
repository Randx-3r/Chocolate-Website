'use strict';
/**
 * Milan Luxe Chocolate - Pesapal backend
 * No npm packages needed (Node 18+).  Run:  node server.js
 *
 * Serves index.html and exposes:
 *   POST /api/checkout        -> creates a Pesapal order, returns the hosted payment page URL
 *   GET  /api/payment-status  -> verifies an order with Pesapal (never trusts the browser)
 *   GET  /api/ipn             -> Pesapal's payment notification (IPN) endpoint
 *   POST /api/contact         -> stores contact-form messages
 *   GET  /admin?key=ADMIN_KEY -> simple page listing orders and messages
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- config
function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const KEY = process.env.PESAPAL_CONSUMER_KEY || '';
const SECRET = process.env.PESAPAL_CONSUMER_SECRET || '';
const ENVIRONMENT = (process.env.PESAPAL_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PESAPAL = process.env.PESAPAL_API_URL || (ENVIRONMENT === 'live' ? 'https://pay.pesapal.com/v3' : 'https://cybqa.pesapal.com/pesapalv3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl');
const IPN_FILE = path.join(DATA_DIR, 'ipn.json');

// Prices live HERE too, so customers can't change them in the browser.
// Keep in sync with PRODUCTS in index.html.
const CATALOG = {
  'milan-coffee': { name: 'Coffee Blend', price: 350 },
  'milan-strawberry': { name: 'Strawberry Blend', price: 350 },
  'milan-cycle': { name: 'Cycle Blend', price: 380 },
};
const BOX_SIZES = [6, 12, 24];

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store',
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// simple per-IP rate limit (in memory)
const hits = new Map();
function rateLimited(ip, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

// ---------------------------------------------------------------- storage
let orders = {};
try { orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { orders = {}; }
function saveOrders() {
  const tmp = ORDERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(orders, null, 2));
  fs.renameSync(tmp, ORDERS_FILE);
}

// ---------------------------------------------------------------- pesapal client
async function pesapal(method, endpoint, body, token) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  let r, text;
  try {
    r = await fetch(PESAPAL + endpoint, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    text = await r.text();
  } catch (e) {
    throw new Error(`Could not reach Pesapal (${e.message})`);
  }
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const apiErr = data && data.error && (data.error.message || data.error.code);
  if (!r.ok || apiErr) throw new Error(`Pesapal error ${r.status}: ${apiErr || text.slice(0, 200)}`);
  return data;
}

let tokenCache = { token: null, expires: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires - 30_000) return tokenCache.token;
  if (!KEY || !SECRET) throw new Error('Pesapal keys are missing. Fill in PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET in .env');
  const d = await pesapal('POST', '/api/Auth/RequestToken', { consumer_key: KEY, consumer_secret: SECRET });
  if (!d.token) throw new Error('Pesapal did not return a token. Check your consumer key/secret and PESAPAL_ENV.');
  tokenCache = { token: d.token, expires: d.expiryDate ? new Date(d.expiryDate).getTime() : Date.now() + 4 * 60_000 };
  return d.token;
}

async function getIpnId() {
  const url = `${BASE_URL}/api/ipn`;
  try {
    const saved = JSON.parse(fs.readFileSync(IPN_FILE, 'utf8'));
    if (saved.url === url && saved.env === ENVIRONMENT && saved.ipn_id) return saved.ipn_id;
  } catch { /* not registered yet */ }
  const token = await getToken();
  const d = await pesapal('POST', '/api/URLSetup/RegisterIPN', { url, ipn_notification_type: 'GET' }, token);
  if (!d.ipn_id) throw new Error('Pesapal did not return an IPN id.');
  fs.writeFileSync(IPN_FILE, JSON.stringify({ url, env: ENVIRONMENT, ipn_id: d.ipn_id }));
  return d.ipn_id;
}

// ---------------------------------------------------------------- orders
function computeOrder(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 30) throw new HttpError(400, 'Your cart is empty.');
  let total = 0; const lines = [];
  for (const it of items) {
    const qty = Number(it && it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new HttpError(400, 'Invalid quantity in cart.');
    if (it.type === 'bar') {
      const p = CATALOG[it.id];
      if (!p) throw new HttpError(400, 'Unknown product in cart.');
      total += p.price * qty; lines.push(`${qty} x ${p.name} bar`);
    } else if (it.type === 'box') {
      if (!BOX_SIZES.includes(it.capacity) || typeof it.mix !== 'object' || !it.mix) throw new HttpError(400, 'Invalid custom box.');
      let count = 0, price = 0; const parts = [];
      for (const [id, q] of Object.entries(it.mix)) {
        const p = CATALOG[id];
        if (!p || !Number.isInteger(q) || q < 1) throw new HttpError(400, 'Invalid custom box contents.');
        count += q; price += p.price * q; parts.push(`${q} ${p.name.replace(' Blend', '')}`);
      }
      if (count !== it.capacity) throw new HttpError(400, 'Custom box is not full.');
      total += price * qty; lines.push(`${qty} x ${it.capacity}-box (${parts.join(', ')})`);
    } else {
      throw new HttpError(400, 'Invalid cart item.');
    }
  }
  return { total, lines };
}

function validateCustomer(c) {
  if (!c || typeof c !== 'object') throw new HttpError(400, 'Missing customer details.');
  const name = String(c.name || '').trim();
  const email = String(c.email || '').trim();
  const address = String(c.address || '').trim();
  let phone = String(c.phone || '').replace(/[\s-]/g, '');
  if (name.length < 2 || name.length > 100) throw new HttpError(400, 'Please enter your full name.');
  if (!/^(?:\+?254|0)[17]\d{8}$/.test(phone)) throw new HttpError(400, 'Please enter a valid Kenyan phone number, e.g. 0712345678.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) throw new HttpError(400, 'Please enter a valid email address.');
  if (address.length < 5 || address.length > 200) throw new HttpError(400, 'Please enter your delivery address.');
  phone = '254' + phone.replace(/^\+?254|^0/, '');
  return { name, email, address, phone };
}

async function handleCheckout(req, res) {
  const body = await readJson(req);
  const customer = validateCustomer(body.customer);
  const { total, lines } = computeOrder(body.items);

  const ref = 'ML-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase();
  const [first, ...rest] = customer.name.split(/\s+/);
  const token = await getToken();
  const notification_id = await getIpnId();

  const d = await pesapal('POST', '/api/Transactions/SubmitOrderRequest', {
    id: ref,
    currency: 'KES',
    amount: total,
    description: `Milan Luxe Chocolate order ${ref}`.slice(0, 100),
    callback_url: `${BASE_URL}/payment-complete`,
    cancellation_url: `${BASE_URL}/payment-complete`,
    notification_id,
    billing_address: {
      email_address: customer.email,
      phone_number: customer.phone,
      country_code: 'KE',
      first_name: first,
      last_name: rest.join(' ') || first,
      line_1: customer.address.slice(0, 100),
    },
  }, token);

  if (!d.redirect_url || !d.order_tracking_id) throw new Error('Pesapal did not return a payment page.');

  orders[ref] = {
    ref, trackingId: d.order_tracking_id, status: 'pending', total, items: lines,
    customer, created: new Date().toISOString(),
  };
  saveOrders();
  send(res, 200, { redirectUrl: d.redirect_url, ref });
}

// Ask Pesapal for the real status and update our record.
async function refreshOrder(order) {
  if (order.status === 'paid') return order;
  const token = await getToken();
  const s = await pesapal('GET', `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(order.trackingId)}`, null, token);
  let status = 'pending';
  if (s.status_code === 1) status = (Number(s.amount) >= order.total && (!s.currency || s.currency === 'KES')) ? 'paid' : 'review';
  else if (s.status_code === 2) status = 'failed';
  else if (s.status_code === 3) status = 'reversed';
  if (status !== order.status) {
    order.status = status;
    order.paymentMethod = s.payment_method || order.paymentMethod;
    order.confirmationCode = s.confirmation_code || order.confirmationCode;
    order.updated = new Date().toISOString();
    saveOrders();
    if (status === 'paid') console.log(`PAID  ${order.ref}  KSh ${order.total}  ${order.customer.name}  ${order.customer.phone}`);
  }
  return order;
}

async function handleStatus(url, res) {
  const ref = url.searchParams.get('ref') || '';
  const order = orders[ref];
  if (!order) throw new HttpError(404, 'Order not found.');
  await refreshOrder(order);
  send(res, 200, { ref: order.ref, status: order.status, total: order.total });
}

async function handleIpn(url, res) {
  const trackingId = url.searchParams.get('OrderTrackingId') || '';
  const ref = url.searchParams.get('OrderMerchantReference') || '';
  const type = url.searchParams.get('OrderNotificationType') || 'IPNCHANGE';
  const order = orders[ref];
  if (order && order.trackingId === trackingId) {
    try { await refreshOrder(order); } catch (e) { console.error('IPN refresh failed:', e.message); }
  }
  send(res, 200, { orderNotificationType: type, orderTrackingId: trackingId, orderMerchantReference: ref, status: 200 });
}

async function handleContact(req, res) {
  const b = await readJson(req, 16 * 1024);
  const rec = {
    time: new Date().toISOString(),
    name: String(b.name || '').slice(0, 100), phone: String(b.phone || '').slice(0, 30),
    email: String(b.email || '').slice(0, 120), interest: String(b.interest || '').slice(0, 100),
    message: String(b.message || '').slice(0, 2000),
  };
  if (!rec.name || !rec.message || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(rec.email)) throw new HttpError(400, 'Please fill in your name, a valid email and a message.');
  fs.appendFileSync(MESSAGES_FILE, JSON.stringify(rec) + '\n');
  console.log(`MESSAGE from ${rec.name} <${rec.email}>`);
  send(res, 200, { ok: true });
}

function handleAdmin(url, res) {
  const given = Buffer.from(url.searchParams.get('key') || '');
  const want = Buffer.from(ADMIN_KEY);
  if (!ADMIN_KEY || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 404, 'Not found', 'text/plain');
  const list = Object.values(orders).sort((a, b) => b.created.localeCompare(a.created));
  let msgs = [];
  try { msgs = fs.readFileSync(MESSAGES_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse(); } catch { /* none */ }
  const rows = list.map((o) => `<tr class="${esc(o.status)}"><td>${esc(o.created.slice(0, 16).replace('T', ' '))}</td><td>${esc(o.ref)}</td><td><b>${esc(o.status.toUpperCase())}</b></td><td>KSh ${o.total}</td>
    <td>${esc(o.items.join('; '))}</td><td>${esc(o.customer.name)}<br>${esc(o.customer.phone)}<br>${esc(o.customer.email)}</td><td>${esc(o.customer.address)}</td><td>${esc(o.paymentMethod || '')} ${esc(o.confirmationCode || '')}</td></tr>`).join('');
  const mrows = msgs.map((m) => `<tr><td>${esc(m.time.slice(0, 16).replace('T', ' '))}</td><td>${esc(m.name)}<br>${esc(m.phone)}<br>${esc(m.email)}</td><td>${esc(m.interest)}</td><td>${esc(m.message)}</td></tr>`).join('');
  send(res, 200, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Milan Luxe Admin</title>
<style>body{font:14px system-ui;margin:20px;background:#faf4ed;color:#231308}table{border-collapse:collapse;width:100%;margin-bottom:30px;background:#fff}td,th{border:1px solid #e5d3c0;padding:6px 8px;text-align:left;vertical-align:top}th{background:#3d2413;color:#f3c668}tr.paid td{background:#eefaf0}tr.failed td{background:#fdeeee}</style>
<h2>Orders (${list.length})</h2><table><tr><th>Time</th><th>Ref</th><th>Status</th><th>Total</th><th>Items</th><th>Customer</th><th>Delivery address</th><th>Payment</th></tr>${rows}</table>
<h2>Messages (${msgs.length})</h2><table><tr><th>Time</th><th>From</th><th>Interest</th><th>Message</th></tr>${mrows}</table>`, 'text/html; charset=utf-8');
}

// ---------------------------------------------------------------- server
const INDEX = path.join(__dirname, 'index.html');

const server = http.createServer(async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  try {
    const url = new URL(req.url, BASE_URL);
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/payment-complete')) {
      return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/api/') && p !== '/api/ipn' && rateLimited(ip)) throw new HttpError(429, 'Too many requests. Please wait a minute.');

    if (req.method === 'POST' && p === '/api/checkout') return await handleCheckout(req, res);
    if (req.method === 'GET' && p === '/api/payment-status') return await handleStatus(url, res);
    if (req.method === 'GET' && p === '/api/ipn') return await handleIpn(url, res);
    if (req.method === 'POST' && p === '/api/contact') return await handleContact(req, res);
    if (req.method === 'GET' && p === '/admin') return handleAdmin(url, res);

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('ERROR', e.message);
    // Show setup problems (bad keys, etc.) only in the server console, not to customers.
    send(res, status, { error: status === 500 ? 'We could not start your payment right now. Please try again or contact us.' : e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Milan Luxe running at ${BASE_URL}   (Pesapal: ${ENVIRONMENT})`);
  if (!KEY || !SECRET) console.warn('WARNING: Pesapal keys not set. Copy .env.example to .env and fill them in.');
  if (!ADMIN_KEY) console.warn('Tip: set ADMIN_KEY in .env to enable the /admin orders page.');
});
