# Milan Luxe Chocolate: website + Pesapal payments

`index.html` is the shop. `server.js` is the backend that talks to Pesapal (keys stay on the server).
No `npm install` needed. You only need Node 18 or newer.

## 1. Get Pesapal keys
- Test first: https://developer.pesapal.com (demo/sandbox keys).
- Real money: create a merchant account at https://www.pesapal.com, then use your live consumer key and secret.

## 2. Configure
```bash
cp .env.example .env      # then open .env and fill it in
```
| Setting | Meaning |
|---|---|
| `PESAPAL_CONSUMER_KEY` / `PESAPAL_CONSUMER_SECRET` | your Pesapal keys |
| `PESAPAL_ENV` | `sandbox` while testing, `live` for real payments |
| `BASE_URL` | the PUBLIC https address of your site (no trailing slash) |
| `ADMIN_KEY` | long random password for the orders page |

## 3. Run
```bash
node server.js
```
Open the address you set as `BASE_URL`.

**Pesapal must be able to reach your site** (it calls `/api/ipn`, and sends customers back to `/payment-complete`).
`localhost` will not work for that. While testing on your computer, run a tunnel such as
`npx cloudflared tunnel --url http://localhost:3000` (or ngrok) and put the https address it gives you in `BASE_URL`.
When you go live, host this folder on a Node host (Render, Railway, a VPS) and use your domain.

## Orders and messages
Open `https://YOUR-SITE/admin?key=YOUR_ADMIN_KEY` to see orders (paid, failed, pending), delivery details and contact messages.
Data is stored in the `data/` folder, so back it up. Never share `.env`.

## Prices
Prices are re-checked on the server (`CATALOG` at the top of `server.js`). If you change a price in `index.html`, change it there too.
