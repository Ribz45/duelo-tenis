# Duelo Ténis — servidor online

Servidor do modo online do Duelo Ténis: contas de jogador (sem palavras-passe), amigos, presença em tempo
real, convites dentro do jogo, resultados/estatísticas/confrontos diretos, e um **relay por WebSocket** para que
dois telemóveis consigam sempre jogar juntos, mesmo quando a ligação WebRTC direta (PeerJS) falha.

O contrato completo (caminhos, formatos, mensagens, limites) está em [`../docs/online-api.md`](../docs/online-api.md).

## Como está feito

- **Cloudflare Worker** (JavaScript simples, módulos ES, sem passo de build nem frameworks), no **plano gratuito**.
- **`Hub`** — Durable Object com SQLite, instância global única (`idFromName('global')`). Guarda utilizadores,
  amizades, partidas, estatísticas e limites de pedidos em `ctx.storage.sql`, e gere a presença e os convites
  pelos WebSockets do hub (API de hibernação).
- **`Room`** — Durable Object, um por partida online. Só faz relay entre os dois jogadores; não guarda nada.

| Ficheiro | O quê |
|---|---|
| `src/index.js` | Worker de entrada: CORS, `/api/health`, encaminha `/api/*` e `/ws` para o Hub e `/ws/room/:id` para a Room |
| `src/hub.js` | Durable Object `Hub`: WebSockets do hub, presença, convites, criação de partidas e bilhetes |
| `src/api.js` | Endpoints HTTP (`/api/register`, `/api/me`, amigos, utilizadores, partidas, ICE) |
| `src/store.js` | Consultas SQL (sempre parametrizadas): utilizadores, amigos, recorde, h2h, limites |
| `src/schema.js` | Esquema SQLite e migrações |
| `src/room.js` | Durable Object `Room`: relay, `$room`/`$join`/`$leave`, reconexão, limites de frames |
| `src/ice.js` | `/api/ice`: STUN fixo + TURN opcional (Cloudflare Realtime TURN ou TURN estático) |
| `src/util.js` | Ids aleatórios, SHA-256/HMAC, bilhetes, validação, respostas JSON |
| `test/` | Testes (`node:test`) e o `run.mjs` que arranca o `wrangler dev` |

Notas de desenho:

- **Hibernação**: o estado de cada socket (utilizador, estado `lobby`/`match`, …) vive em `serializeAttachment` e
  é sempre reconstruído com `ctx.getWebSockets()`. Os **convites ficam em SQLite** (tabela `invites`, com
  expiração), por isso sobrevivem a o Hub hibernar ou ser reiniciado. Só os contadores de mensagens/s por socket
  estão em memória — se o objeto hibernar recomeçam do zero, o que é inofensivo.
- **Tokens**: o servidor guarda apenas `SHA-256(token)`. O token também é aceite escrito à mão (minúsculas,
  hífenes, I/L→1, O→0).
- **Logs**: os *invocation logs* automáticos estão desligados em `wrangler.toml`, porque guardariam o URL do
  WebSocket do hub, que leva `?token=…`. Os `console.log`/`console.error` do código nunca incluem tokens, bilhetes
  nem IPs (o IP do limite de registos só é guardado como HMAC).

### Códigos de fecho dos WebSockets

| Código | Onde | Significado |
|---|---|---|
| `4000` | Room | `replaced`: o mesmo jogador voltou a ligar-se; este socket antigo foi substituído |
| `4001` | Hub | `too many connections`: mais de 5 abas/sockets do mesmo utilizador; fecha-se o mais antigo |
| `4003` | Room | bilhete inválido/expirado (ou sala cheia): a Room aceita o upgrade e fecha logo, para o jogo saber que não deve voltar a tentar (um browser não vê o status HTTP de um upgrade recusado) |
| — | Hub | token inválido: o upgrade é recusado com `401` (o browser vê `1006`) |

## Correr localmente

Precisa de Node 22+ (os testes usam o `fetch` e o `WebSocket` globais do Node 24).

```sh
cd server
npm install
npx wrangler dev --port 8787        # ou: npm run dev
```

A API fica em `http://localhost:8787` (por exemplo `http://localhost:8787/api/health`) e os WebSockets em
`ws://localhost:8787/ws?token=…` e `ws://localhost:8787/ws/room/<matchId>?ticket=…`.

O segredo local (`SECRET`) está em `server/.dev.vars` (não vai para o git). Se apagares esse ficheiro, cria outro:

```sh
node -e "console.log('SECRET=' + require('crypto').randomBytes(32).toString('base64url'))" > .dev.vars
```

### Testes

```sh
cd server
npm test
```

O `npm test` arranca o `wrangler dev` na porta 8787 (com uma base de dados limpa numa pasta temporária, um
limite de registos baixo e convites de 1,5 s para os testes serem rápidos), espera pelo `/api/health`, corre todos
os `test/*.test.mjs` e pára o servidor no fim. Se já houver um `wrangler dev` a correr na 8787, reutiliza-o (aí os
limites são os normais e o teste de expiração de convites demora ~30 s). Com `DT_SHOW_LOGS=1` mostra o log do
`wrangler dev` quando algum teste falha.

> **Windows:** se o repositório estiver numa pasta muito funda, o `wrangler dev` pode falhar com
> `SQLITE_CANTOPEN` (caminho com mais de 260 caracteres). Usa uma pasta de estado curta:
> `npx wrangler dev --port 8787 --persist-to C:\tmp\dt-state`. O `npm test` já faz isto sozinho.

## Publicar (conta Cloudflare nova e gratuita)

1. Cria uma conta gratuita em <https://dash.cloudflare.com/sign-up> e confirma o email.
2. No terminal, dentro de `server/`:

   ```sh
   npm install
   npx wrangler login
   ```

   Abre o browser para autorizares o Wrangler na tua conta.
3. Publica o Worker:

   ```sh
   npx wrangler deploy
   ```

   Na primeira vez, se a conta ainda não tiver um subdomínio `workers.dev`, o Wrangler pede para escolheres um
   (ou escolhe-o no painel em **Workers & Pages**). No fim mostra o URL, com este formato:

   `https://duelo-tenis-api.<o-teu-subdominio>.workers.dev`

4. Define o segredo de produção (gera um valor novo, nunca reutilizes o do `.dev.vars`):

   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   npx wrangler secret put SECRET
   ```

   Cola o valor quando o Wrangler o pedir. O `secret put` publica logo uma nova versão do Worker. Até este passo,
   os endpoints que precisam do segredo respondem `500 misconfigured` (falham fechados).

   **Não mudes o `SECRET` depois de haver jogadores**: os links de amigo (`linkKey`) e os bilhetes das salas
   dependem dele; mudá-lo invalida todos os links de amigo já partilhados.

5. Verifica:

   ```sh
   curl https://duelo-tenis-api.<o-teu-subdominio>.workers.dev/api/health
   ```

6. No jogo, aponta a base da API para `https://duelo-tenis-api.<o-teu-subdominio>.workers.dev` (WebSockets em
   `wss://duelo-tenis-api.<o-teu-subdominio>.workers.dev/ws` e `/ws/room/<matchId>`).

### TURN (opcional)

Sem TURN, o `/api/ice` devolve só STUN e o jogo usa o relay da Room quando a ligação direta falha — funciona
sempre. Para dar mais hipóteses à ligação direta WebRTC:

**Cloudflare Realtime TURN**

1. No painel da Cloudflare: **Realtime** → **TURN Server** → **Create** (dá-lhe um nome, por ex. `duelo-tenis`).
2. Guarda o **Turn Token ID** e o **API Token** que aparecem (o token só é mostrado uma vez).
3. Em `server/`:

   ```sh
   npx wrangler secret put TURN_KEY_ID      # cola o Turn Token ID
   npx wrangler secret put TURN_KEY_TOKEN   # cola o API Token
   ```

O servidor pede credenciais válidas por 24 h e guarda-as em cache ~1 h. Confirma no painel/página de preços da
Cloudflare quanto tráfego TURN está incluído sem custos antes de ativar.

**TURN estático (outro fornecedor)**: define `TURN_URLS` (separados por vírgulas) e `TURN_USERNAME` em `[vars]`
no `wrangler.toml`, e a credencial como segredo: `npx wrangler secret put TURN_CREDENTIAL`.

Se o TURN falhar (rede, credenciais), o `/api/ice` continua a responder, só com STUN.

## Logs e monitorização

- **Painel**: <https://dash.cloudflare.com> → **Workers & Pages** → `duelo-tenis-api` → **Logs** (Workers Logs,
  ativado por `[observability]` no `wrangler.toml`). Mostra os `console.log`/`console.error` do Worker e dos
  Durable Objects (`register`, `match_created`, `match_disputed`, `hub_error`, …). No plano gratuito a retenção é
  curta (poucos dias).
- **Em direto no terminal**: `npx wrangler tail` (ou `npm run tail`).
- **Métricas** (pedidos, erros, uso dos Durable Objects): na mesma página do Worker, separador **Metrics**, e em
  **Durable Objects** no painel.

## Limites e notas para produção

- **Plano gratuito**: o Worker e os Durable Objects têm limites diários de pedidos e de duração. Cada pedido HTTP
  conta para o Worker e para o Hub. O relay é o mais caro: enquanto há frames a passar, a Room está ativa e cada
  mensagem recebida conta (as mensagens WebSocket contam como uma fração de pedido). O jogo deve preferir a
  ligação WebRTC direta e usar a Room como recurso, e enviar só o necessário (o servidor descarta frames > 16 KB e
  mais de 80 frames/s por socket).
- **Hub único**: todos os dados e a presença estão num só Durable Object. Chega bem para um jogo pequeno
  (centenas de jogadores em simultâneo); para muito mais seria preciso partir os dados.
- **Limites de abuso** (além do contrato): registos 20/h por IP; pedidos de amizade 60/h por utilizador;
  relatórios de partidas 300/h por utilizador; máximo 200 amigos e 50 pedidos pendentes enviados; até 5 sockets do
  hub por utilizador (o mais antigo é fechado); até 5 convites pendentes por remetente; mensagens do hub até 4 KB
  e 10/s por socket; relatórios online aceites até 24 h depois de a partida ser criada e até ao jogo nº 50.
- **Presença**: um jogador fica offline quando o último socket do hub fecha. Se um telemóvel desaparecer sem
  fechar a ligação (bateria, túnel), só sai quando o runtime der pela ligação morta; o servidor não expulsa sockets
  silenciosos (o jogo faz `ping` a cada 25 s, por isso isto pode ser acrescentado mais tarde com um alarme).
- **Recorde**: é calculado a partir da tabela `results` em cada pedido (sem tabela de agregados). Para um jogo
  pequeno chega; com milhares de jogos por jogador valerá a pena guardar totais.
- **Resultados online**: o primeiro relatório conta logo para o recorde (`reported`); o segundo confirma
  (`confirmed`) ou marca `disputed` (o primeiro prevalece). Como só amigos podem criar partidas, o risco de batota
  fica entre amigos.
