# Duelo Ténis

Jogo de ténis 3D gratuito para o telemóvel (vertical), para jogar contra o CPU ou contra amigos.
Publicado em <https://ribz45.github.io/duelo-tenis/> (GitHub Pages, ramo `main`).

## Estrutura

| Pasta / ficheiro | O que é |
|---|---|
| `index.html` | Página única: ecrãs, estilos e HUD |
| `game.js` | Jogo: física da bola, regras em campo, CPU, controlos (swipe), câmara, HUD, estatísticas do jogo |
| `online.js` | Modo online: perfil, amigos, lobby com presença, convites, ligação ao adversário (relé + direta) |
| `config.js` | Endereço do servidor online (`PROD` depois do deploy) |
| `rules.js` | Regras puras (pontuação, serviço, dentro/fora) — testadas em `tests/rules.test.mjs` |
| `athlete-gltf.js`, `player3d.js` | Jogadores 3D (Rocketbox + pancadas por captura de movimento) |
| `fx.js`, `audio.js` | Efeitos visuais e som |
| `sw.js`, `manifest.webmanifest`, `icons/` | App instalável que abre sem internet |
| `models/`, `vendor/` | Modelos 3D, Three.js e fontes (licenças nas próprias pastas) |
| `server/` | Servidor online (Cloudflare Worker + Durable Objects) — ver `server/README.md` |
| `docs/online-api.md` | Contrato entre o jogo e o servidor |
| `tests/` | Testes das regras (`npm test`) e de equilíbrio do jogo (`tests/balance.js`, no browser) |

## Correr no computador

1. Jogo: servir esta pasta em `http://localhost:8765` (qualquer servidor estático, por exemplo
   `python -m http.server 8765`).
2. Servidor online (opcional, para o lobby): `cd server && npm install && npx wrangler dev --port 8787`.
   Em `localhost` o jogo liga-se sozinho a `http://localhost:8787`.
3. Para testar dois jogadores no mesmo computador abre `http://localhost:8765` e `http://127.0.0.1:8765`
   (cada endereço guarda o seu próprio perfil).

## Testes

- `npm test` — regras do ténis.
- `cd server && npm test` — servidor (contas, amigos, convites, relé, resultados).
- Equilíbrio (no browser, com o jogo aberto): `const b = await import('./tests/balance.js'); b.serves(40); b.play(1, 80)`.

## Publicar

- Servidor: ver `server/README.md` (`npx wrangler deploy`), depois pôr o endereço em `config.js` (`PROD`).
- Jogo: subir `VERSION` em `sw.js` e o `?v=` dos módulos, fazer merge para `main` (GitHub Pages publica sozinho).

## Créditos

Jogadores: Microsoft Rocketbox (MIT) · Pancadas: Tennis-MoCap, Pulgarin-Giraldo et al. (CC BY-SA 3.0) ·
Corrida: Quaternius (CC0) · Three.js (MIT) · Fontes Barlow (OFL).
