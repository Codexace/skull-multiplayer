# ☠ SKULL — Multiplayer

A web-based multiplayer version of the bluffing card game **Skull**.

## Quick Start

```bash
cd skull-multiplayer
npm install
node server.js
```

Then open **http://localhost:3000** in your browser.

## Playing with Friends

**On your local network (LAN):**
1. Find your local IP (`ipconfig` on Windows, `ifconfig` / `ip addr` on Mac/Linux)
2. Friends connect to `http://YOUR_IP:3000`

**Over the internet:**
- Use a tunneling service like [ngrok](https://ngrok.com): `ngrok http 3000`
- Or deploy to a cloud provider (Render, Railway, Fly.io, etc.)

## How to Play

1. **Create a room** — you get a 4-letter code
2. **Share the code** with friends (2–6 players)
3. **Host starts the game** when everyone has joined

Each player has 4 coasters: 3 Roses 🌹 and 1 Skull 💀

- **Place** coasters face-down each turn
- **Bid** on how many you can flip without hitting a skull
- **Flip** — your own stack first, then choose from opponents
- Hit a skull? Lose a coaster permanently
- **First to 2 wins** takes the game!
