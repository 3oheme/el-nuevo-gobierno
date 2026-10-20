'use strict';

// ---------- Config ----------

const APP_VERSION = 'v6';
const API = 'https://public.api.bsky.app/xrpc/';
const W = 1200;
const H = 1500;
const SLOTS = 15;

const CABINETS = {
  serio: [
    'Presidencia',
    'Vicepresidencia y Defensa',
    'Economía y Hacienda',
    'Exteriores y UE',
    'Justicia e Interior',
    'Agricultura y Medio Rural',
    'Comercio y Competitividad',
    'Seguridad Nacional y Fronteras',
    'Transportes y Movilidad',
    'Educación y Universidades',
    'Cultura y Familias',
    'Sanidad y Consumo',
    'Trabajo y Seguridad Social',
    'Industria y Energía',
    'Política Territorial',
  ],
  internet: [
    'Presidencia',
    'Vicepresidencia del Algoritmo',
    'Memes y Shitposting',
    'Hilos Interminables',
    'Asuntos Exteriores (X)',
    'Bloqueos y Silencios',
    'Discusiones a las 3 AM',
    'Capturas de Pantalla',
    'Fotos de Gatos',
    'Opiniones No Pedidas',
    'Cultura y Spoilers',
    'Sanidad Mental Digital',
    'Trabajo y Procrastinación',
    'Reposts sin Contexto',
    'Hashtags y Tendencias',
  ],
};

// ---------- State ----------

const state = {
  me: null,          // profile
  people: [],        // [{did, handle, displayName, avatar, img}]
  ministries: [],    // strings, same length as people
};

// ---------- DOM ----------

const $ = (s) => document.querySelector(s);
const form = $('#form');
const statusEl = $('#status');
const goBtn = $('#go');
const canvas = $('#poster');
const ctx = canvas.getContext('2d');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
}

// ---------- Bluesky API ----------

async function xrpc(method, params) {
  const url = new URL(API + method);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
    const err = new Error(detail || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function normalizeHandle(raw) {
  let h = raw.trim();
  h = h.replace(/^https?:\/\/(www\.)?bsky\.app\/profile\//i, '');
  h = h.replace(/\/.*$/, '').replace(/^@/, '').toLowerCase();
  if (!h) return '';
  if (!h.startsWith('did:') && !h.includes('.')) h += '.bsky.social';
  return h;
}

// Scores accounts by how often the user replies to, reposts, quotes or mentions them.
async function topInteractions(did, maxPages = 4) {
  const scores = new Map();
  const known = new Map(); // did -> basic profile
  const bump = (author, pts) => {
    if (!author || author.did === did) return;
    scores.set(author.did, (scores.get(author.did) || 0) + pts);
    if (author.handle) known.set(author.did, author);
  };

  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const data = await xrpc('app.bsky.feed.getAuthorFeed', {
      actor: did, limit: 100, cursor, filter: 'posts_with_replies',
    });
    for (const item of data.feed || []) {
      const post = item.post;
      const isRepost = item.reason && String(item.reason.$type).includes('reasonRepost');
      if (isRepost) { bump(post.author, 2); continue; }
      if (post.author.did !== did) continue;

      // Replies
      const parent = item.reply && item.reply.parent;
      if (parent && parent.author) bump(parent.author, 3);

      // Quotes
      const emb = post.embed;
      const rec = emb && (emb.record && emb.record.record ? emb.record.record : emb.record);
      if (rec && rec.author) bump(rec.author, 3);

      // Mentions
      for (const facet of (post.record && post.record.facets) || []) {
        for (const f of facet.features || []) {
          if (String(f.$type).endsWith('#mention') && f.did) bump({ did: f.did }, 2);
        }
      }
    }
    cursor = data.cursor;
    if (!cursor) break;
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => known.get(d) || { did: d });
}

async function follows(did, maxPages = 3) {
  const out = [];
  let cursor;
  for (let page = 0; page < maxPages; page++) {
    const data = await xrpc('app.bsky.graph.getFollows', { actor: did, limit: 100, cursor });
    out.push(...(data.follows || []));
    cursor = data.cursor;
    if (!cursor) break;
  }
  return out;
}

// Fills in missing handle/avatar data (e.g. accounts found only through mentions).
async function hydrate(list) {
  const missing = list.filter((p) => !p.handle).map((p) => p.did);
  const byDid = new Map();
  for (let i = 0; i < missing.length; i += 25) {
    const data = await xrpc('app.bsky.actor.getProfiles', { actors: missing.slice(i, i + 25) });
    for (const p of data.profiles || []) byDid.set(p.did, p);
  }
  return list.map((p) => byDid.get(p.did) || p).filter((p) => p.handle);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function uniqueByDid(list) {
  const seen = new Set();
  return list.filter((p) => (seen.has(p.did) ? false : (seen.add(p.did), true)));
}

// ---------- Images ----------

// cdn.bsky.app does not send CORS headers, so its images would block the PNG export.
// Instead we fetch the original blob from the user's PDS (which allows CORS),
// and fall back to a public image proxy that also allows it.

function loadImage(src, cors = true) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    if (cors) img.crossOrigin = 'anonymous';   // keeps the canvas exportable
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function timeoutSignal(ms) {
  return typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

const pdsCache = new Map();
function pdsFor(did) {
  if (!pdsCache.has(did)) {
    pdsCache.set(did, (async () => {
      const url = did.startsWith('did:web:')
        ? `https://${did.slice(8)}/.well-known/did.json`
        : `https://plc.directory/${did}`;
      const res = await fetch(url, { signal: timeoutSignal(8000) });
      if (!res.ok) throw new Error('did doc HTTP ' + res.status);
      const doc = await res.json();
      const svc = (doc.service || []).find((s) => String(s.id).endsWith('#atproto_pds'));
      if (!svc) throw new Error('no pds');
      return svc.serviceEndpoint.replace(/\/$/, '');
    })());
  }
  return pdsCache.get(did);
}

// https://cdn.bsky.app/img/avatar/plain/<did>/<cid>@jpeg -> { did, cid }
function parseAvatarUrl(url) {
  const m = /\/img\/[^/]+\/[^/]+\/(did:[^/]+)\/([^/@]+)/.exec(url || '');
  return m && { did: decodeURIComponent(m[1]), cid: m[2] };
}

async function avatarFromPds(avatarUrl) {
  const ref = parseAvatarUrl(avatarUrl);
  if (!ref) return null;
  const pds = await pdsFor(ref.did);
  const url = `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(ref.did)}&cid=${encodeURIComponent(ref.cid)}`;
  const res = await fetch(url, { signal: timeoutSignal(10000) });
  if (!res.ok) throw new Error('getBlob HTTP ' + res.status);
  const objectUrl = URL.createObjectURL(await res.blob());
  const img = await loadImage(objectUrl, false);
  URL.revokeObjectURL(objectUrl);
  if (!img) throw new Error('no se pudo decodificar');
  return img;
}

// Tries several sources and records why each one failed, so the status line can explain it.
async function loadAvatar(person) {
  const url = person.avatar;
  person.avatarLog = [];
  if (!url) { person.avatarLog.push('sin avatar'); return null; }

  let img = await loadImage(url);
  if (img) { person.avatarVia = 'cdn'; return img; }
  person.avatarLog.push('cdn: bloqueado');

  try {
    img = await avatarFromPds(url);
    if (img) { person.avatarVia = 'pds'; return img; }
    person.avatarLog.push('pds: sin imagen');
  } catch (err) {
    person.avatarLog.push('pds: ' + (err && err.message ? err.message : err));
  }

  img = await loadImage('https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=500&h=500&fit=cover&output=jpg');
  if (img) { person.avatarVia = 'proxy'; return img; }
  person.avatarLog.push('proxy: falló');
  return null;
}

// Canvas fonts have no emoji glyphs; strip them so names measure and center correctly.
function cleanText(s) {
  return String(s || '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{Zs}&+=$€%°|]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- Drawing ----------

function drawBackground() {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#111a2e');
  bg.addColorStop(1, '#070c17');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Waving flag in the top-left corner, drawn off-screen and faded with an alpha mask.
  const off = document.createElement('canvas');
  off.width = 1000; off.height = 520;
  const o = off.getContext('2d');
  drawFlag(o);
  o.globalCompositeOperation = 'destination-in';
  const mask = o.createRadialGradient(60, 40, 40, 60, 40, 600);
  mask.addColorStop(0, 'rgba(0,0,0,.9)');
  mask.addColorStop(0.5, 'rgba(0,0,0,.45)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  o.fillStyle = mask;
  o.fillRect(0, 0, off.width, off.height);
  ctx.drawImage(off, 0, 0);
}

function drawFlag(ctx) {
  ctx.save();
  ctx.translate(-60, -40);
  ctx.rotate(-0.12);
  const fw = 1100, bands = [['#c60b1e', 0.25], ['#ffc400', 0.5], ['#c60b1e', 0.25]];
  let y = 0;
  for (const [color, frac] of bands) {
    const h = 340 * frac;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= fw; x += 10) ctx.lineTo(x, y + Math.sin(x / 70) * 14);
    for (let x = fw; x >= 0; x -= 10) ctx.lineTo(x, y + h + Math.sin(x / 70) * 14);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    y += h;
  }
  ctx.restore();
}

function drawHeader(title, subtitle) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,.6)';
  ctx.shadowBlur = 16;
  let size = 132;
  ctx.font = `${size}px Anton, Oswald, Impact, sans-serif`;
  while (ctx.measureText(title).width > W - 120 && size > 60) {
    size -= 4;
    ctx.font = `${size}px Anton, Oswald, Impact, sans-serif`;
  }
  ctx.fillText(title, W / 2, 170);

  ctx.shadowBlur = 0;
  ctx.font = '600 50px Oswald, sans-serif';
  ctx.letterSpacing = '8px';
  const tw = ctx.measureText(subtitle).width;
  ctx.fillText(subtitle, W / 2, 248);
  ctx.letterSpacing = '0px';

  ctx.fillStyle = '#d72631';
  const lineW = 150, gap = 26, cy = 232;
  ctx.fillRect(W / 2 - tw / 2 - gap - lineW, cy, lineW, 5);
  ctx.fillRect(W / 2 + tw / 2 + gap, cy, lineW, 5);
  ctx.restore();
}

function wrapLines(text, maxW, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width <= maxW || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

// Shrinks the font until the text fits in maxLines.
function fitText(text, font, start, min, maxW, maxLines) {
  for (let s = start; s >= min; s--) {
    ctx.font = font(s);
    const lines = wrapLines(text, maxW, maxLines);
    if (lines && lines.every((l) => ctx.measureText(l).width <= maxW)) return { size: s, lines };
  }
  ctx.font = font(min);
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return { size: min, lines: [t + (t === text ? '' : '…')] };
}

function drawPhoto(person, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (person.img) {
    const img = person.img;
    const s = Math.max(w / img.width, h / img.height);
    const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else {
    // Fallback: initial on a colored background
    const hue = [...person.did].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, `hsl(${hue} 45% 38%)`);
    g.addColorStop(1, `hsl(${(hue + 40) % 360} 45% 22%)`);
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.font = `${Math.round(h * 0.45)}px Anton, Oswald, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const initial = [...(cleanText(person.displayName) || person.handle || '?')][0].toUpperCase();
    ctx.fillText(initial, x + w / 2, y + h / 2 + 4);
  }
  // Soft shadow at the bottom of the photo
  const sh = ctx.createLinearGradient(0, y + h - 60, 0, y + h);
  sh.addColorStop(0, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,.35)');
  ctx.fillStyle = sh;
  ctx.fillRect(x, y + h - 60, w, 60);
  ctx.restore();
}

function drawCard(person, ministry, x, y, w, h) {
  const photoH = Math.round(h * 0.6);
  ctx.fillStyle = '#0f1729';
  ctx.fillRect(x, y, w, h);
  drawPhoto(person, x, y, w, photoH);

  ctx.strokeStyle = '#2b3a58';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  const pad = 12, cx = x + w / 2, maxW = w - pad * 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';

  // Ministry (up to 2 lines)
  const m = fitText(ministry.toUpperCase(), (s) => `600 ${s}px Oswald, sans-serif`, 23, 15, maxW, 2);
  ctx.font = `600 ${m.size}px Oswald, sans-serif`;
  const lh = m.size * 1.08;
  let ty = y + photoH + 14 + m.size;
  if (m.lines.length === 1) ty += lh / 2;
  for (const l of m.lines) { ctx.fillText(l, cx, ty); ty += lh; }

  // Red rule
  const ruleY = y + photoH + 14 + lh * 2 + 8;
  ctx.fillStyle = '#d72631';
  ctx.fillRect(cx - w * 0.33, ruleY, w * 0.66, 4);

  // Name
  ctx.fillStyle = '#f1f1f1';
  const name = cleanText(person.displayName) || person.handle || '';
  const n = fitText(name, (s) => `500 ${s}px Oswald, sans-serif`, 25, 19, maxW, 1);
  ctx.font = `500 ${n.size}px Oswald, sans-serif`;
  ctx.fillText(n.lines[0], cx, ruleY + 38);

  // "Party": the handle as a colored badge
  const handle = '@' + (person.handle || '').replace(/\.bsky\.social$/, '');
  const hb = fitText(handle, (s) => `700 ${s}px Oswald, sans-serif`, 20, 17, maxW - 16, 1);
  ctx.font = `700 ${hb.size}px Oswald, sans-serif`;
  const bw = Math.min(maxW, ctx.measureText(hb.lines[0]).width + 20);
  const by = ruleY + 56;
  ctx.fillStyle = '#1185fe';
  roundRect(cx - bw / 2, by, bw, hb.size + 12, 6);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(hb.lines[0], cx, by + hb.size + 3);
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function render() {
  ctx.direction = 'ltr';
  const n = state.people.length;
  drawBackground();
  drawHeader('EL NUEVO GOBIERNO', `LOS ${n} MINISTROS`);

  const cols = 5, rows = Math.ceil(n / cols);
  const margin = 28, gap = 14, top = 300, bottom = 40;
  const cw = (W - margin * 2 - gap * (cols - 1)) / cols;
  const ch = (H - top - bottom - gap * (rows - 1)) / rows;

  state.people.forEach((p, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    // Center the last row if it is incomplete
    const inRow = r === rows - 1 ? n - r * cols : cols;
    const offset = ((cols - inRow) * (cw + gap)) / 2;
    drawCard(p, state.ministries[i], margin + offset + c * (cw + gap), top + r * (ch + gap), cw, ch);
  });

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,.35)';
  ctx.font = '400 16px Oswald, sans-serif';
  ctx.fillText('Parodia · generado con tus datos públicos de Bluesky', W - margin, H - 14);
}

// ---------- Editor ----------

function renderEditor() {
  const ol = $('#slots');
  ol.innerHTML = '';
  state.people.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<div class="row"><input type="text" aria-label="Cartera"><input type="text" aria-label="Nombre"></div>';
    const [mIn, nIn] = li.querySelectorAll('input');
    mIn.value = state.ministries[i];
    nIn.value = p.displayName || p.handle;
    mIn.addEventListener('input', () => { state.ministries[i] = mIn.value; render(); });
    nIn.addEventListener('input', () => { p.displayName = nIn.value; render(); });
    ol.appendChild(li);
  });
}

// ---------- Main flow ----------

async function buildCabinet(handle, source) {
  setStatus('Buscando tu perfil…');
  const me = await xrpc('app.bsky.actor.getProfile', { actor: handle });

  let others = [];
  if (source === 'interactions') {
    setStatus('Leyendo tus últimas publicaciones…');
    others = await topInteractions(me.did);
  }
  if (others.length < SLOTS - 1) {
    setStatus(source === 'follows' ? 'Mirando a quién sigues…' : 'Completando con gente a la que sigues…');
    const f = await follows(me.did);
    others = others.concat(source === 'follows' ? shuffle(f) : f);
  }
  others = uniqueByDid(others).filter((p) => p.did !== me.did).slice(0, SLOTS + 10);

  setStatus('Recogiendo perfiles…');
  others = (await hydrate(others)).slice(0, SLOTS - 1);
  return [me, ...others];
}

async function attachImages(people) {
  setStatus('Descargando avatares…');
  await Promise.all(people.map(async (p) => { p.img = await loadAvatar(p); }));
}

function avatarSummary(people) {
  const count = (via) => people.filter((p) => p.avatarVia === via).length;
  const failed = people.filter((p) => !p.img);
  let msg = `Listo (${APP_VERSION}). Avatares: ${count('cdn')} cdn, ${count('pds')} pds, ${count('proxy')} proxy, ${failed.length} sin imagen.`;
  if (failed.length) msg += ` Ejemplo de fallo (@${failed[0].handle}): ${failed[0].avatarLog.join(' · ')}`;
  return msg;
}

async function ensureFonts() {
  try {
    await Promise.all([
      document.fonts.load('130px Anton'),
      document.fonts.load('600 40px Oswald'),
      document.fonts.load('500 25px Oswald'),
      document.fonts.load('700 20px Oswald'),
    ]);
  } catch { /* system fallback fonts are fine */ }
}

function showResult() {
  render();
  renderEditor();
  $('#result').hidden = false;
  $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const handle = normalizeHandle($('#handle').value);
  if (!handle) return setStatus('Escribe un usuario.', true);
  const source = form.source.value;
  const cabinet = CABINETS[form.cabinet.value];

  goBtn.disabled = true;
  try {
    const [people] = await Promise.all([buildCabinet(handle, source), ensureFonts()]);
    if (people.length < 2) throw new Error('No hemos encontrado a nadie con quien formar gobierno.');
    await attachImages(people);
    state.me = people[0];
    state.people = people;
    state.ministries = cabinet.slice(0, people.length);
    setStatus(avatarSummary(people));
    showResult();
  } catch (err) {
    console.error(err);
    const msg = err.status === 400
      ? 'No existe ese usuario en Bluesky (o la cuenta es privada).'
      : `Algo ha fallado: ${err.message}`;
    setStatus(msg, true);
  } finally {
    goBtn.disabled = false;
  }
});

$('#shuffle').addEventListener('click', () => {
  // The user keeps the Presidency; everyone else gets a new portfolio.
  const rest = shuffle(state.ministries.slice(1));
  state.ministries = [state.ministries[0], ...rest];
  render();
  renderEditor();
});

$('#download').addEventListener('click', () => {
  try {
    canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `nuevo-gobierno-${(state.me && state.me.handle) || 'bsky'}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, 'image/png');
  } catch (err) {
    setStatus('No se pudo exportar la imagen (bloqueo CORS de algún avatar).', true);
  }
});

// Prefill from ?u=handle
const params = new URLSearchParams(location.search);
if (params.get('u')) $('#handle').value = params.get('u');

// Demo mode (?demo) renders fake data without touching the network.
if (params.has('demo')) {
  const names = ['Ana Pérez', 'Luis Gómez', 'Marta Ruiz', 'Javier Sanz', 'Lucía Torres', 'Pablo Díaz',
    'Carmen Vidal', 'Sergio Molina', 'Elena Castro', 'Raúl Ortega', 'Nuria Gil', 'Diego Romero',
    'Irene Navarro', 'Hugo Delgado', 'Sara Iglesias con Nombre Muy Largo'];
  state.people = names.map((n, i) => ({ did: 'did:demo:' + i, displayName: n, handle: n.split(' ')[0].toLowerCase() + '.bsky.social' }));
  state.me = state.people[0];
  state.ministries = CABINETS[params.get('demo') === 'internet' ? 'internet' : 'serio'].slice();
  ensureFonts().then(showResult);
}
