# Duelo Ténis — Characters, Career mode and extras (design plan)

Status: built on branch `carreira-personagens` (2026-11-20). Notes in *Built* boxes say where the build differs from the proposal.
In-game text stays in Portuguese; names below in *italics* are the labels players will see.

Hard constraints for everything here:
- **Fast to play.** A match stays a 10-point tie-break (~3 min). Nothing adds waiting, timers or long menus.
- **Free to host.** Everything runs on the phone. The server only stores small saves and leaderboards
  (the existing Cloudflare free plan: one request per match, a few KB per player).
- **No pay-to-win, no energy timers, no ads.** The game is free and stays fair.
- **No real players, tournaments or brands.**

---

## 1. What the reference games teach us

| Game | What works | What players complain about | Take-away for us |
|---|---|---|---|
| **Mario Tennis Aces** | Six clear play styles (All-around, Power, Speed, Technical, Defensive = reach, Tricky = curve). You know a character's style at a glance. | — | Characters need a **visible identity**, not just numbers. |
| **Tennis Clash** | Six stats per character (agility, stamina, serve, volley, forehand, backhand); gear raises stats; tours unlocked by trophies. | Upgrades cost huge amounts of coins; stats got unbalanced (agility far above the rest) and had to be rebalanced. | Few stats, a fixed **total budget** per character, no coin walls. |
| **Tennis Arena** (our model for feel) | Tie-break-10 matches; coaching challenges to improve skills; online tournaments. | Pay-to-win cards/coins; "+40 to a stat doesn't feel noticeable". | Every stat point must be **felt** on court. Progress through play, not purchases. |
| **TopSpin 2K25 MyCAREER** | Monthly loop: training → challenges → tournament; coaches give bonuses after their challenges; status unlocks bigger events. | Energy/injury management, slow progression, "little real sense of progression". | Keep the loop, drop the energy chores, make each tournament **visibly** move you up. |
| **Virtua Tennis 4 World Tour** | Career as a board-game map; "stars" gate the big events. | Moving around the map with tickets was irritating. | Gate events by **ranking**, but choosing the next event must be one tap. |
| **AO Tennis 2** | Earnings and XP raise stats; *Scenarios* (win with N aces, N winners…). | Career felt repetitive; no way to shorten matches. | Add variety with conditions/challenges; let you **simulate** easy early rounds. |
| **Retro Bowl** | Matches of a few minutes, almost no menus, a season fits in an afternoon, every game feeds the long arc. | — | The template for "fast": **one tournament ≈ one coffee break**, autosave everywhere. |

Sources: [TopSpin 2K25 MyCAREER (2K)](https://topspin.2k.com/2k25/features/mycareer), [Charlie Intel on energy and injuries](https://charlieintel.com/games/topspin-2k25-mycareer-energy-level-how-to-avoid-injuries-320098),
[Twinfinite review](https://twinfinite.net/reviews/topspin-2k25-review/), [Tennis Clash stats guide (LevelWinner)](https://www.levelwinner.com/?p=31904),
[Tennis Clash Tennis 2.0 (Wildlife)](https://wildlifestudios.com/tennis-2-0/), [Mario Tennis Aces types (Prima)](https://primagames.com/tips/mario-tennis-aces-character-types),
[Tennis Arena on the App Store](https://apps.apple.com/us/app/tennis-arena/id1551093164), [Virtua Tennis 4 review (GameWatcher)](https://www.gamewatcher.com/reviews/virtua-tennis-4-review/9332),
[Virtua Tennis 4 review (Gaming Nexus)](https://gamingnexus.com/Article/3085/Virtua-Tennis-4), [AO Tennis 2 review (Press Start)](https://press-start.com.au/reviews/nintendo-switch/2020/01/10/ao-tennis-2-review-a-huge-improvement/),
[Retro Bowl (GamesRadar)](https://www.gamesradar.com/au/retro-bowls-addictive-simplicity-makes-it-one-of-the-best-sports-games-in-recent-years/).

---

## 2. Stats: five numbers that change how a match plays

Each player has five stats from 1 to 10. **6 is today's game** (the current balance), so nothing changes for
someone who picks the all-rounder. Each point is a few percent — small enough to keep skill in charge,
big enough that 3 points (e.g. 6 → 9) is clearly felt.

| Stat (*label*) | What it changes in the code today | Per point vs 6 | At 3 | At 9 |
|---|---|---|---|---|
| Speed (*Velocidade*) | run speed (`RUN_SPEED` 6.2 m/s), auto-run reaction | ±3.5 % speed | 5.6 m/s | 6.9 m/s |
| Reach (*Alcance*) | hitting radius (`reachOf`, 1.8 m) | ±0.07 m | 1.6 m | 2.0 m |
| Power (*Potência*) | rally shot speed (`shotSpec` speedH) and the pressure it puts on the returner | ±2.2 % | −6.6 % | +6.6 % |
| Serve (*Serviço*) | first-serve speed and the serve pressure that makes aces (`svPress`) | ±3.5 % speed, ±4 % accuracy | fewer aces | many more aces |
| Control (*Controlo*) | ball scatter (`sig`), size of the "perfect" timing window (`greenWin`) | ±6 % scatter, ±4 % window | wilder, smaller window | tighter, bigger window |

Why five, not six: Tennis Clash's forehand/backhand split adds numbers without adding a new feeling,
and their own patch notes show how hard many stats are to balance. Volley skill can come later as a
character trait (see the net player below) once the CPU knows how to volley.

**Balance rule:** every selectable character has the same total (30 points). Career players grow beyond it
(see §4), but online friendlies always use characters, so they stay fair.

---

> *Built:* `chars.js` holds the stats and the multipliers; power was lowered from ±3 % to ±2.2 % per point because extra pace
> also makes the CPU miss more (at 3 %, the power character won 49 % of points where the others won 38–42 %).

## 3. Selectable characters (*Tenistas*)

Six characters, one per play style, each with a look you recognise from far away (outfit colour,
hair, height/build — all done with the existing male/female models and colour masks, no new 3D files).

| Character | Style | Vel. | Alc. | Pot. | Serv. | Cont. | How it plays | Look |
|---|---|---|---|---|---|---|---|---|
| **Tom** | All-rounder | 6 | 6 | 6 | 6 | 6 | Today's player. Best for learning. | white/navy, cap |
| **Claire** | Big server | 4 | 5 | 7 | 9 | 5 | Free points on serve, but long rallies are a struggle. | red, tall |
| **Alex** | Defender / counter-puncher | 7 | 9 | 3 | 4 | 7 | Gets everything back; you win by outlasting, not by hitting through. | teal, wide stance |
| **Mia** | Speed | 9 | 6 | 4 | 5 | 6 | Reaches impossible balls; needs angles to finish points. | orange, light build |
| **Ryan** | Touch / precision | 5 | 6 | 4 | 6 | 9 | Huge perfect window, deadly drop shots and lobs; low pace. | purple, headband |
| **Leo** | Power baseliner | 5 | 5 | 9 | 6 | 5 | Every perfect shot is a winner chance, but errors creep in. | black/lime |

Names are simple, generic English first names (Tom, Claire, Alex, Mia, Ryan, Leo, Sophie); styles keep a Portuguese label in the game. Each character also gets one small **signature** that is pure feel,
not stats: a celebration, a racket colour, a grunt pitch.

**Where you pick them:** a horizontal card strip before *Jogo rápido*, *Torneio* and online challenges
(the choice is remembered). Online, the host's `start` message carries both characters, so each phone
draws the right player; every phone already computes its own shots, so stats apply naturally.

**CPU opponents get personalities too.** The CPU uses the same characters, and its decisions follow the
style: Muralha lobs and defends deep, Martelo aims closer to the lines, Artista uses more drop shots,
Canhão goes for the corners on serve. (A real net-rusher needs CPU volleys, which the CPU doesn't do today —
later phase.)

> *Built:* seven characters — the six above plus **Sophie** (net rusher: spd 6, rch 7, pow 5, srv 7, ctl 5, trait: safer volleys
> with +0.18 m reach). The CPU now volleys when it is near the net, and so does the human auto-run (it used to pull you back to the bounce).
> Characters are told apart by model, skin, outfit and hair; body height/build was dropped because scaling the skeleton breaks the
> racket-to-ball arm calibration. Measured (simulated player, 120–200 points each vs the same medium CPU): Tom 38 %, Alex 38 %,
> Ryan 40 %, Sophie 41 %, Claire 42 % (most aces, shortest rallies), Mia 42 %, Leo 43 % — all within 38–43 %.

**Balance check before release:** extend `tests/balance.js` to play every character against every other
with the simulated player. Target: no match-up below 40 % or above 60 % over 200 points.

---

## 4. Career mode (*Carreira*)

### The fantasy
"Start as a nobody ranked #200 at a small club tournament, become world #1 and win the four Majors."

### Core loop (one tournament = 10–20 minutes)
1. **Season screen** — this week's events (1–3 choices). One tap to enter.
2. **Tournament** — a small draw; each round is one tie-break-10 match. Bigger events have more rounds;
   Major semi-finals and finals are best of three tie-breaks for drama (the only longer matches).
3. **Rewards screen** — ranking points, XP, prize money, a short "story" line (new ranking, a title, the rival's result).
4. **Spend** (optional, ten seconds): put new attribute points into stats, buy/upgrade a piece of gear, hire a coach.
5. Next week. Autosave after every match, so you can stop at any moment.

### Your player
- Create: name, look (existing outfits), and a **starting style** (one of the six characters' shapes).
- Start at **total 15** (e.g. Canhão-shaped: serve 4, power 3, the rest 2–3). That is clearly weaker than the
  selectable characters (30) — you *feel* the climb.
- Cap: 10 per stat, total up to ~45 at the end (stronger than any selectable character, a reward for the career).

### Season structure (12 weeks; a full season ≈ 2–3 hours)
| Tier (*name in game*) | Draw | Rounds | Ranking needed | Points (winner) | Opponent strength (stat total) |
|---|---|---|---|---|---|
| Club Futures (*Futuros*) | 8 | 3 | any | 25 | 13–20 |
| Challenger (*Challenger*) | 16 | 4 | top 180 | 80 | 18–25 |
| Tour 250 (*Circuito 250*) | 16 | 4 | top 100 | 250 | 23–30 |
| Tour 500 (*Circuito 500*) | 16 | 4 | top 60 | 500 | 27–34 |
| Masters (*Masters*) | 32 | 5 | top 30 | 1000 | 31–38 |
| Major (*Grand Slam*) | 32 | 5 (SF/F best of 3) | top 20, or a wild card | 2000 | 34–42 |
| Season Finals (*Finais*) | top 8 | group + KO | top 8 at season end | 1500 | 38–44 |

- Four invented Majors, one per surface family, spread over the season (weeks 3, 6, 9, 12):
  *Open do Atlântico* (hard), *Taça da Terra* (clay), *Relva Real* (grass), *Open da Cidade* (hard, night session).
- **Wild cards** (*convite*): win the previous tier's event and you can jump one gate — keeps
  good players from grinding low tiers.
- **Ranking**: a field of 200 invented players (generated names, styles, strengths). Each week the
  others' results are simulated from their strength (instant, on the phone). Points count for the last
  12 weeks (one season), so the ranking moves every week.
- **Simulate a round** (*Simular*): allowed when you are the clear favourite; you get half the XP.
  Early-career rounds against much weaker players never waste your time.

### Growth (no grinding, no coins walls)
- **XP → levels → attribute points.** Win ≈ 100 × tier factor, loss ≈ 40 %, plus bonuses (aces, long rallies,
  comebacks). About one level per tournament early on, slower later. Each level = 1 point (2 at milestones).
- **Coaches** (*Treinadores*, max 1 at a time, change between seasons): each gives +1 to one stat and a small
  perk you can feel — e.g. *Treinador de serviço*: the perfect-serve window is 10 % bigger; *Preparador físico*:
  faster recovery to the centre after a shot; *Treinador mental*: on match point your timing window grows.
  Unlocked by ranking milestones, not by paying (TopSpin lesson: coaches are fun when they feel personal).
- **Gear** (*Material*: racket, strings, shoes) bought with prize money: +1 to a stat, max +2 per stat from gear,
  plus cosmetics. Prize money comes only from playing — there is nothing to buy with real money.
- **Training weeks** (*Treino*): instead of a tournament you can do 3 short challenges (Tennis Arena's
  coaching + AO Tennis 2's Scenarios): "hit 5 serves into the T box", "win a 15-shot rally",
  "win a point with a drop shot". Fun, ~3 minutes, good XP. Also the tutorial for new skills.

### Story and variety (so it doesn't repeat — AO Tennis 2's weakness)
- **A rival** (*Rival*): generated with the opposite style to yours, starts near your ranking, climbs with you,
  and is placed in your draw at key moments (first final, first Major). Two-line exchanges before those matches.
- **Milestones with a moment**: first title, top 100, top 10, first Major, #1 — each gets a full-screen card and
  a trophy in the cabinet (*Vitrine*).
- **Conditions** that change play cheaply: surfaces (exist), night sessions with floodlights (lighting only),
  a windy week (small constant ball drift — later).
- **Legacy**: a career score (titles, weeks at #1, Majors). After 5 seasons you can retire to the Hall of Fame
  (*Hall da Fama*) and start a new career with a cosmetic bonus.

### Save and sync (free to host)
- The career lives in `localStorage` (about 20–60 KB of JSON: your player, the 200-player field, the season).
- Backup to your profile on the existing server: one `PUT /api/career` after each tournament
  (max 64 KB, newest version wins; restored when you sign in on another phone with the account code).
- Friends see each other's career ranking and titles in the lobby. Server cost: a few requests per tournament.

---

## 5. Other extras worth adding (cheapest and highest value first)

| Extra | Why it's good | Cost | Server |
|---|---|---|---|
| **Instant replay** of great points (*Repetição*): last 6 s in slow motion from the TV camera, auto after 20-shot rallies and match points | Shareable "wow", feels like a broadcast | Low: record ball/player positions each frame, replay them | none |
| **Daily challenge** (*Desafio do dia*): the same scenario for everyone that day, friends' leaderboard | A reason to open the game daily, 2 minutes | Low: seeded scenarios (reuse training challenges) | 1 tiny table |
| **Quick reactions online** (*Reações*): 4 preset emotes between points | Social fun with friends | Low: one message type in the relay | none |
| **Achievements** (*Conquistas*) | Long-term goals across all modes | Low | sync with profile |
| **Friends ladder** (*Liga de amigos*): Elo rating from online matches | Bragging rights; the server already stores every result | Low | query on existing data |
| **Night matches** with floodlights | Visual variety | Medium: lighting presets | none |
| **Spectate a friend's match** (*Ver jogo*) | Lobby feels alive | Medium: the room relay already supports it in principle | small |
| **Volleys for the CPU + net-rusher character** | A seventh style that comes to the net | Medium-high: new CPU decisions | none |
| Doubles | Popular in tennis games | High: 4 players, AI teammates, new camera | relay changes |

---

## 6. Build order (each phase can be released on its own)

1. **Characters** (1 session): stats system mapped to the existing parameters, 6 characters, picker screen,
   CPU personalities, online support, balance matrix test. Immediately changes the dynamics in every mode.
2. **Career core** (1–2 sessions): create player, 200-player ranking, season calendar with tiers,
   tournaments with brackets, XP and attribute points, prize money, rewards screen, local save + cloud backup.
3. **Career depth** (1 session): coaches, gear, training challenges, rival story, Majors best of 3,
   trophy cabinet, Hall of Fame.
4. **Extras** (1 session each or combined): instant replay, daily challenge, reactions, achievements, friends ladder.

Performance budget for all phases: no new 3D files (characters are recolours/scales of the existing
models), no new libraries, career JSON under 64 KB, menus reachable in ≤ 2 taps from the main menu.
