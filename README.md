# Personal Dashboard

A set of small, self-contained HTML apps that share a top bar.

## Deploy your own copy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FRowanThistlebrooke%2FYTdashh1)

One click → Vercel signs you in, copies the repo to your GitHub, and deploys it. ~30 seconds to a live URL.

## How to use

Open any `.html` file directly in your browser — no build step, no install.

| File | What it is |
|---|---|
| [index.html](index.html) | Goals tracker (Day Ring, Goal Ticker, To Do list) — the home page |
| [health.html](health.html) | Supplement / daily stack tracker |
| [finance.html](finance.html) | Finances |
| [gym.html](gym.html) | Progressive overload gym tracker |
| [daily.html](daily.html) | Daily log and the 30-day challenge |
| [track.html](track.html) | Timer: time tracking by project, auto-fills the daily log |
| [caffeine.html](caffeine.html) | Caffeine intake and timing |
| [guide.html](guide.html) | The manual: what each page is for and how the pieces connect |
| [topbar.js](topbar.js) | Shared top bar with the menu drawer and the bottom tabs — auto-injected into pages that `<script src="topbar.js">` |
| lab-theme.css, lab-pages.css, lab-main.css, lab-*.css | The look: a 1940s laboratory document. Tokens, the shared page layer, and one thin file per page |

Each app stores its own state in browser `localStorage`. No accounts, no server.

## Building from scratch

[BUILD_DASHBOARD.md](BUILD_DASHBOARD.md) is the prompt I gave Claude to generate `index.html` — paste it into Claude if you want to rebuild that page yourself.
