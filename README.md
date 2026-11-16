# StayFree connector for Claude

An unofficial [MCP](https://modelcontextprotocol.io) server that lets Claude read your
[StayFree](https://stayfreeapps.com) screen time: every app and website, from your phone,
browsers and computers. Then you can ask questions about your habits in plain language.

You run your own copy for free on your own Cloudflare account. It needs no password. It joins
your StayFree device group with a normal pairing code, the same way you'd link a new phone.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bobby-sills/stayfree-mcp)

> **Not affiliated with StayFree or Sensor Tower.** StayFree has no public API, so this uses the
> same sync API the StayFree browser extension uses. It could break if they change it. Only
> use it with your own data.

## What you can ask Claude

- "How much screen time did I have today? What took up the most?"
- "Compare my phone use this week to last week."
- "How much YouTube have I watched this month, and what time of day do I usually watch it?"
- "What was I doing on my phone between 11pm and 2am last night?"
- "Which websites do I spend the most time on during school hours?"
- "What usage limits do I have set?"

## Tools

| Tool | What it does |
|---|---|
| `get_screen_time` | Total, daily average, and per-device, per-day and per-hour totals, plus top apps and top websites for a date range. Can filter by app, platform or device |
| `get_app_usage` | One app or site in detail: time per day and hour, number of sessions, median and longest session, first and last use, recent sessions |
| `get_timeline` | Everything used on a given day, in order, with start and end times |
| `get_limits_and_settings` | Your synced usage limits, blocked keywords, categories and ignore list |
| `list_devices` | The phones, browsers and computers in your StayFree group |
| `get_status` | Whether the connector is paired, and your time zone |
| `connect_device` / `disconnect` | Pair or unpair the connector |

Time where sessions overlap on the same device (a website and the browser it's open in, for
example) is counted once. Time on different devices is added together. Android apps show
their real names (YouTube, not `com.google.android.youtube`).

## Setup (about 5 minutes, all in the browser)

You need StayFree's cross-device sync set up already. For example, the Chrome extension
should be linked to your phone under **Dashboard → Manage Devices**. You also need a free
[Cloudflare](https://dash.cloudflare.com/sign-up) account and a GitHub account.

1. Click **Deploy to Cloudflare** above. Cloudflare copies this repo into your GitHub and asks for:
   - `TIMEZONE`: your time zone, e.g. `Asia/Vientiane`, `America/New_York` or `Europe/London`
     ([full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)).
   - `MCP_SECRET`: a long random string you make up (letters and numbers, at least 16 characters).
     Treat it like a password.
2. Click **Create and deploy**. When it finishes, you'll see a Worker URL like
   `https://stayfree-mcp.<your-subdomain>.workers.dev`.
3. In Claude, go to **Settings → Connectors → Add custom connector**. Use this URL and leave the OAuth fields empty:
   ```
   https://stayfree-mcp.<your-subdomain>.workers.dev/mcp/<your MCP_SECRET>
   ```
4. Ask Claude **"connect to StayFree"**. Claude gives you a pairing code.
5. In the StayFree browser extension, open **Dashboard → Manage Devices → Connect Device → Enter a Code**
   and type the code. A device called "Claude connector" joins your group.
6. Ask Claude "how much screen time did I have today?"

You can also pair the other way round. Get a code from one of your StayFree apps and tell
Claude "connect to StayFree with code 123456".

## Security and privacy

- Your screen time stays between StayFree's servers, your own Worker and Claude.
- The connector URL contains your `MCP_SECRET`. Anyone with the URL can read your screen time,
  so don't share it. To change it, go to **Workers & Pages → stayfree-mcp → Settings → Variables and Secrets**,
  then update the connector URL in Claude.
- The connector is a member of your device group, and it shows up in StayFree's device list.
  To revoke it, remove "Claude connector" in **Manage Devices**, or ask Claude to `disconnect`.
- The only things the connector stores (in Workers KV) are its own random device ID, your group
  key and a cache of app names. It never stores your usage data.

## How it works

StayFree's apps upload usage sessions to `api.stayfreeapps.com`, and devices in the same group
can read each other's sessions. On first use, this Worker creates its own random 13-character
device ID. It registers that ID the same way the extension does, then joins your group with a
pairing code. After that, `GET /v1/sync/devices/sessions` returns start times and durations for
every Android, iOS, Windows, Mac and Linux app and every website in the group. The Worker splits
them into days and hours in your time zone.

## Development

```sh
npm install
npm test          # aggregation and time zone tests
npm run typecheck
cp .dev.vars.example .dev.vars   # set MCP_SECRET
npm run dev       # http://localhost:8787/mcp/<MCP_SECRET>
```

## License

MIT
