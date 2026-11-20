# Duelo Ténis — online API (contract between the game and the server)

Server: one Cloudflare Worker (`server/`), free plan. Two Durable Object classes, both SQLite-backed
(`new_sqlite_classes`), both using the WebSocket **hibernation** API (`ctx.acceptWebSocket`, `webSocketMessage`,
`webSocketClose`, `serializeAttachment`):

- `Hub` — a single global instance (`idFromName('global')`). Owns all durable data in its own SQLite
  (`ctx.storage.sql`): users, friendships, matches, per-match stats, rate limits. Also owns presence and invites
  (hub WebSockets). Every `/api/*` request and `/ws` upgrade is forwarded by the Worker to this instance.
- `Room` — one instance per online match (`idFromName(matchId)`). Pure relay between the two players
  (game messages + WebRTC signaling). Keeps nothing durable.

All JSON. Errors: HTTP 4xx/5xx with `{ "error": "<code>", "message": "<human text>" }`.
CORS: `Access-Control-Allow-Origin: *`, allow headers `Authorization, Content-Type`, methods
`GET, POST, PATCH, DELETE, OPTIONS` (auth is a bearer token, never a cookie, so `*` is safe).

## Identity

- No passwords. `POST /api/register` creates an account and returns a **token** (26 chars, Crockford base32,
  ≥128 bits random). The game stores it on the device and shows it to the player as their
  "account code" so they can sign in on another phone. Server stores only `SHA-256(token)` (hex).
- HTTP auth: `Authorization: Bearer <token>`. WebSocket auth: `?token=<token>` query (browsers can't set headers).
- `id`: 12 chars base32 random. `tag`: friend code, 5 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, unique.
- `name`: trimmed, control chars removed, 1–16 chars. `look`: integer 0–9 (avatar outfit), default 0.

**Public user object**: `{ id, name, tag, look }`

## HTTP endpoints

| Method & path | Auth | Body | Response |
|---|---|---|---|
| `GET /api/health` | no | – | `{ ok:true, time }` |
| `POST /api/register` | no | `{ name, look? }` | `{ token, user, linkKey }` — rate limit 20/hour per `CF-Connecting-IP` (`429 rate_limited`) |
| `GET /api/me` | yes | – | `{ user, linkKey, record, friends, requests:{ incoming:[user], outgoing:[user] } }` |
| `PATCH /api/me` | yes | `{ name?, look? }` | `{ user }` |
| `POST /api/friends` | yes | `{ tag, key? }` | `{ status, user }` — `status`: `requested` (pending, other side must accept), `friends` (now friends: either the other side had already requested me, or `key` is the valid `linkKey` of that tag), `already`. Errors: `404 not_found`, `400 self` |
| `POST /api/friends/:id/accept` | yes | – | `{ friend }` (404 if no pending request from `:id`) |
| `DELETE /api/friends/:id` | yes | – | `{ ok:true }` — removes friendship, or declines/cancels a pending request either way |
| `GET /api/users/:id` | yes | – | `{ user, record, h2h:{ w, l }, recent:[match] }` — `h2h`/`recent` are me vs `:id` (last 10) |
| `POST /api/matches` | yes | see below | `{ ok:true, status }` |
| `GET /api/matches?with=<id>&limit=<n≤50>` | yes | – | `{ matches:[match] }` my latest matches (optionally only vs `with`) |
| `GET /api/ice` | yes | – | `{ iceServers:[RTCIceServer] }` |

`linkKey`: first 8 chars of base64url(HMAC-SHA256(SECRET, "link:" + tag)). Only ever returned to the owner.
The game builds a friend link `https://…/duelo-tenis/#f=<TAG>.<linkKey>`; whoever opens it and posts
`{ tag, key }` becomes a friend at once (the owner shared it, so that's consent).

`friends[]` items: `{ ...user, online:bool, status:'lobby'|'match'|null, lastSeen:<ms epoch>, h2h:{ w, l } }`

`/api/ice`: always `stun:stun.cloudflare.com:3478` and `stun:stun.l.google.com:19302`. Plus TURN when configured:
- Cloudflare Realtime TURN if env `TURN_KEY_ID` + `TURN_KEY_TOKEN` are set:
  `POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers`
  with `Authorization: Bearer {TURN_KEY_TOKEN}`, body `{ "ttl": 86400 }` → response `{ iceServers:[...] }`
  (also accept the older `/credentials/generate` shape `{ iceServers:{ urls, username, credential } }`). Cache ~1 h.
- or static env `TURN_URLS` (comma separated) + `TURN_USERNAME` + `TURN_CREDENTIAL`.
Failure to get TURN must never fail the endpoint (STUN only, plus the game falls back to the Room relay).

### Match reports — `POST /api/matches`

Online (both players report; the first report stores the result, the second confirms it; if they disagree on
`winner` the match is kept with `status:'disputed'` and the first report wins):
```json
{ "mode":"online", "matchId":"…", "game":1, "winner":"<userId>", "score":[6,4],
  "stats": { "<userId>": { …player stats… }, "<otherUserId>": { … } } }
```
`score` is indexed by player: `[0]` = host (`p1`), `[1]` = guest (`p2`). `game` = 1, 2, 3… for rematches in the
same room. The server checks that `matchId` exists, the reporter is `p1` or `p2`, and `winner` is one of them.
Response `status`: `reported` | `confirmed` | `disputed`.

Versus the CPU (single report, deduplicated by `clientId`):
```json
{ "mode":"cpu", "clientId":"<random 16+ chars>", "level":1, "won":true, "score":[10,7], "stats":{ …my stats… } }
```

**Player stats** (all integers ≥ 0, clamp to sane bounds, unknown keys ignored):
`pointsWon, pointsPlayed, aces, doubleFaults, firstIn, firstTotal, firstWon, secondWon, secondTotal,
winners, errors, fastestServe (km/h, ≤ 260), longestRally (≤ 500)`

**record** (in `/api/me` and `/api/users/:id`):
```json
{ "online":{ "w":3, "l":2 }, "cpu":{ "w":5, "l":1 },
  "totals":{ "matches":11, "pointsWon":0, "pointsPlayed":0, "aces":0, "doubleFaults":0, "firstIn":0, "firstTotal":0,
             "firstWon":0, "secondWon":0, "secondTotal":0, "winners":0, "errors":0, "fastestServe":0, "longestRally":0 } }
```
(`fastestServe` and `longestRally` are maxima, everything else sums.)

**match** item: `{ id, game, mode, level, opp:user|null, won:bool, score:[mine, theirs], status, at }`

## Hub WebSocket — `GET /ws?token=…`

On connect the server sends `{ t:'hello', me:user, friends:[friend] }` and marks the user online with status
`lobby`, broadcasting `{ t:'presence', id, online:true, status }` to their online friends.
A user may have several sockets (two tabs); they're online while any is open. On the last close:
`{ t:'presence', id, online:false, status:null, lastSeen }`.

Client → server:
- `{ t:'ping' }` → `{ t:'pong', time }`
- `{ t:'status', s:'lobby'|'match' }` → presence broadcast
- `{ t:'invite', to:<friendId>, cfg:{ surface:'hard'|'clay'|'grass' } }` → if not friends / offline / in a match:
  `{ t:'invite-failed', to, reason:'not-friend'|'offline'|'busy' }`. Else creates invite `{ id, from, to, cfg, exp:now+30s }`,
  sends the target (all sockets) `{ t:'invite', id, from:user, cfg, exp }` and the sender `{ t:'invite-sent', id, to, exp }`.
- `{ t:'invite-cancel', id }` (sender) → target gets `{ t:'invite-cancelled', id }`
- `{ t:'invite-reply', id, accept:bool }` (target) →
  - decline: sender gets `{ t:'invite-declined', id }`
  - expired/unknown: replier gets `{ t:'invite-expired', id }`
  - accept: creates the match row (`p1` = inviter = host, `p2` = invitee), sends both (all their sockets)
    `{ t:'match', matchId, role:'host'|'guest', opp:user, cfg, ticket }`, and sets both statuses to `match`.

Server pushes: `{ t:'friend-request', from:user }`, `{ t:'friend-added', friend }`, `{ t:'friend-removed', id }`
(when the HTTP friend endpoints change something for an online user).

## Room WebSocket — `GET /ws/room/:matchId?ticket=…`

`ticket` = `base64url(JSON{ m:matchId, u:userId, e:expiryMs })` + `.` + `base64url(HMAC-SHA256(SECRET, firstPart))`,
issued by the Hub in the `match` message, valid 3 hours. The Room verifies the HMAC, `m` and `e` (no Hub call).
- At most the two ticket holders. If the same user connects again, the older socket is closed (reconnect).
- On join, the joiner gets `{ "$":"room", you, peers:[userIds already present] }`; the other gets `{ "$":"join", id }`.
- On close: the other gets `{ "$":"leave", id }`.
- **Every other text frame is relayed verbatim to the other player** (no parsing needed). System frames use the key
  `"$"`; game frames use `"t"`, so they never clash.
- Frames > 16 KB are dropped; more than 80 frames/s from one socket are dropped.

## Config

`wrangler.toml`: name `duelo-tenis-api`, DO bindings `HUB` → `Hub`, `ROOM` → `Room`, migration `v1` with
`new_sqlite_classes = ["Hub", "Room"]`, `[observability] enabled = true`.
Secret `SECRET` (HMAC key): `wrangler secret put SECRET` in production, `.dev.vars` locally (gitignored).
Local dev: `npx wrangler dev --port 8787`.
