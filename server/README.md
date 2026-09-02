# The room broker

A rendezvous for two browsers that want to find each other. It holds an offer
and a reply for a few seconds and then forgets them. It never sees a byte of a
race — once the handshake is done the players talk directly, and this could go
down mid-race without anybody noticing.

That is the whole point. Signalling is the one piece of WebRTC you cannot do
peer-to-peer, so it is the only piece worth paying for, and it costs almost
nothing: two strings, four requests, a few seconds.

## Why a Durable Object and not KV

Taking an offer has to be **atomic**. An offer belongs to exactly one
`RTCPeerConnection` on the host — if two guests read the same one, both answer
it, and the host can only complete one of them, the other guest waits forever
for a connection nobody is finishing.

Cloudflare KV is eventually consistent, with propagation measured in tens of
seconds. A guest would poll for an offer that was claimed twenty seconds ago, or
poll for a reply that is already there and not see it. It is the wrong tool
however cheap it is.

A Durable Object is single-threaded and strongly consistent, which makes the
claim a plain `if` with no locking. Rooms are ephemeral — sixty seconds of state
— so there is no storage at all, just a `Map` in memory. Nothing to back up,
nothing to migrate, nothing to pay for.

## Deploying

```bash
cd server
npx wrangler login
npx wrangler deploy
```

That prints a URL like `https://rsc-rooms.<subdomain>.workers.dev`. Point the
game at it by setting `ROOM_BROKER` in `src/net/roomHttp.ts`, or per-session with
`?rooms=https://...` for testing against a local `wrangler dev`.

The free plan covers this comfortably: a race costs about eight requests, so
100 000 requests a day is somewhere north of ten thousand races.

## What it deliberately does not do

- **No accounts, no persistence, no history.** A room is a code and two strings.
- **No relay.** It carries no game traffic, so two players behind strict NATs
  still cannot reach each other. That needs TURN, which costs real bandwidth
  and is a separate decision — see `useRelay` in `src/net/webrtc.ts`.
- **No moderation.** Rooms are found by knowing the code, not by browsing. That
  is the difference between "a lobby you share with friends" and a public
  matchmaking service, and it is why this file is ninety lines.

## The API

Four calls, all `POST`, all JSON, all under `/r/:code`.

| Route | Who | Body | Returns |
|---|---|---|---|
| `/r/:code/publish` | host | `{offer}` | `{ticket}` |
| `/r/:code/claim` | guest | — | `{ticket, offer}` or `204` |
| `/r/:code/reply` | guest | `{ticket, reply}` | `204` |
| `/r/:code/collect` | host | — | `{replies: [{ticket, reply}]}` |
| `/r/:code/close` | host | — | `204` |

`collect` drains: a reply is delivered once. Rooms expire sixty seconds after
the last touch, so a lobby left open keeps itself alive by polling and an
abandoned one evaporates.
