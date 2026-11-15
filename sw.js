// Service worker: guarda o jogo no telemóvel para abrir sem internet.
// Ao publicar uma versão nova, sobe VERSION (e o ?v= dos módulos) para os telemóveis a descarregarem.
const VERSION = 'duelo-v8';
const FILES = [
  './', 'index.html', 'manifest.webmanifest',
  'game.js?v=8', 'player3d.js?v=8', 'fx.js?v=8', 'audio.js?v=8', 'rules.js?v=8',
  'athlete-gltf.js?v=8',
  'vendor/three.module.min.js', 'vendor/peerjs.min.js',
  'vendor/jsm/loaders/GLTFLoader.js', 'vendor/jsm/utils/BufferGeometryUtils.js', 'vendor/jsm/utils/SkeletonUtils.js',
  'models/rb/rb_m.glb', 'models/rb/rb_m_body.jpg', 'models/rb/rb_m_head.jpg', 'models/rb/rb_m_body_n.jpg', 'models/rb/rb_m_head_n.jpg',
  'models/rb/rb_m_mask.png', 'models/rb/rb_m_headmask.png',
  'models/rb/rb_f.glb', 'models/rb/rb_f_body.jpg', 'models/rb/rb_f_head.jpg', 'models/rb/rb_f_body_n.jpg', 'models/rb/rb_f_head_n.jpg',
  'models/rb/rb_f_mask.png', 'models/rb/rb_f_headmask.png', 'models/rb/rb_f_hair.png',
  'vendor/fonts/barlow-condensed-latin-600-normal.woff2', 'vendor/fonts/barlow-condensed-latin-700-normal.woff2',
  'vendor/fonts/barlow-condensed-latin-800-normal.woff2', 'vendor/fonts/barlow-condensed-latin-800-italic.woff2',
  'vendor/fonts/barlow-latin-500-normal.woff2', 'vendor/fonts/barlow-latin-600-normal.woff2', 'vendor/fonts/barlow-latin-700-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-48.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// a página pede para ativar já a versão nova (botão "Atualizar")
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // ligação online (PeerJS) vai sempre à rede
  if (req.mode === 'navigate') {                          // abrir o jogo (com ou sem #convite) funciona offline
    e.respondWith(caches.match('index.html').then(r => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
