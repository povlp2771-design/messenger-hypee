const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN = 'durovv';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

let db = { users: {}, messages: [], tokens: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
db.users = db.users || {};
db.messages = db.messages || [];
db.tokens = db.tokens || {};

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); }
    catch (e) { console.error('save error', e.message); }
  }, 300);
}

const has = (n) => Object.prototype.hasOwnProperty.call(db.users, n);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function setPassword(u, pw) {
  u.salt = crypto.randomBytes(16).toString('hex');
  u.hash = hashPw(pw, u.salt);
}
function checkPassword(u, pw) {
  const a = Buffer.from(hashPw(pw, u.salt), 'hex');
  const b = Buffer.from(u.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cleanName(s) {
  s = String(s || '').trim().toLowerCase().replace(/^@/, '');
  if (s.includes('__')) return null;
  return /^[a-z0-9_]{3,20}$/.test(s) ? s : null;
}

// Аккаунт durovv: пароль берётся из переменной ADMIN_PASSWORD
let adminPw = process.env.ADMIN_PASSWORD;
if (!adminPw) {
  adminPw = crypto.randomBytes(6).toString('hex');
  console.log('ADMIN_PASSWORD не задан. Временный пароль для durovv:', adminPw);
}
if (!has(ADMIN)) db.users[ADMIN] = { stars: 0, created: Date.now() };
setPassword(db.users[ADMIN], adminPw);
save();

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
  const reply = (cb, o) => { if (typeof cb === 'function') cb(o); };
  const me = () => socket.data.user;
  const need = (cb) => {
    if (me()) return true;
    reply(cb, { ok: false, error: 'Нужно войти' });
    return false;
  };
  const info = (n) => ({ username: n, stars: db.users[n].stars });
  const enter = (n) => { socket.data.user = n; socket.join('u:' + n); };
  const newToken = (n) => {
    const t = crypto.randomBytes(24).toString('hex');
    db.tokens[t] = n;
    save();
    return t;
  };
  const deliver = (msg) => {
    db.messages.push(msg);
    if (db.messages.length > 50000) db.messages.splice(0, 5000);
    save();
    io.to('u:' + msg.from).to('u:' + msg.to).emit('message', msg);
  };
  const pushBalance = (n) => io.to('u:' + n).emit('balance', db.users[n].stars);

  socket.on('register', (d, cb) => {
    const n = cleanName(d && d.username);
    const pw = String((d && d.password) || '');
    if (!n) return reply(cb, { ok: false, error: 'Юзернейм: 3–20 символов, латиница, цифры, _' });
    if (pw.length < 6) return reply(cb, { ok: false, error: 'Пароль минимум 6 символов' });
    if (n === ADMIN || has(n)) return reply(cb, { ok: false, error: 'Этот юзернейм занят' });
    const u = { stars: 0, created: Date.now() };
    setPassword(u, pw);
    db.users[n] = u;
    save();
    enter(n);
    reply(cb, { ok: true, token: newToken(n), me: info(n) });
  });

  socket.on('login', (d, cb) => {
    const n = cleanName(d && d.username);
    const pw = String((d && d.password) || '');
    if (!n || !has(n) || !checkPassword(db.users[n], pw))
      return reply(cb, { ok: false, error: 'Неверный юзернейм или пароль' });
    enter(n);
    reply(cb, { ok: true, token: newToken(n), me: info(n) });
  });

  socket.on('auth', (token, cb) => {
    const n = db.tokens[String(token)];
    if (!n || !has(n)) return reply(cb, { ok: false });
    enter(n);
    reply(cb, { ok: true, me: info(n) });
  });

  socket.on('logout', (token) => {
    delete db.tokens[String(token)];
    save();
  });

  socket.on('search', (q, cb) => {
    if (!need(cb)) return;
    q = String(q || '').toLowerCase().replace(/^@/, '');
    const list = Object.keys(db.users)
      .filter((n) => n !== me() && n.includes(q))
      .slice(0, 20);
    reply(cb, { ok: true, users: list });
  });

  socket.on('chats', (_, cb) => {
    if (typeof _ === 'function') cb = _;
    if (!need(cb)) return;
    const seen = new Map();
    for (let i = db.messages.length - 1; i >= 0; i--) {
      const m = db.messages[i];
      if (m.from !== me() && m.to !== me()) continue;
      const peer = m.from === me() ? m.to : m.from;
      if (!seen.has(peer)) seen.set(peer, m);
    }
    const chats = [...seen.entries()].map(([user, last]) => ({ user, last }));
    reply(cb, { ok: true, chats });
  });

  socket.on('history', (d, cb) => {
    if (!need(cb)) return;
    const peer = cleanName(d && d.with);
    if (!peer || !has(peer)) return reply(cb, { ok: false, error: 'Нет такого пользователя' });
    const msgs = db.messages
      .filter((m) => (m.from === me() && m.to === peer) || (m.from === peer && m.to === me()))
      .slice(-200);
    reply(cb, { ok: true, messages: msgs });
  });

  socket.on('send', (d, cb) => {
    if (!need(cb)) return;
    const to = cleanName(d && d.to);
    const text = String((d && d.text) || '').trim().slice(0, 2000);
    if (!to || !has(to) || to === me()) return reply(cb, { ok: false, error: 'Неверный получатель' });
    if (!text) return reply(cb, { ok: false, error: 'Пустое сообщение' });
    deliver({ id: crypto.randomUUID(), from: me(), to, text, time: Date.now(), type: 'text' });
    reply(cb, { ok: true });
  });

  socket.on('stars', (d, cb) => {
    if (!need(cb)) return;
    const to = cleanName(d && d.to);
    const amount = Math.floor(Number(d && d.amount));
    if (!to || !has(to) || to === me()) return reply(cb, { ok: false, error: 'Неверный получатель' });
    if (!Number.isFinite(amount) || amount < 1 || amount > 1000000000)
      return reply(cb, { ok: false, error: 'Неверное количество звёзд' });
    if (me() !== ADMIN) {
      // обычный пользователь может только переводить свои звёзды
      if (db.users[me()].stars < amount) return reply(cb, { ok: false, error: 'Недостаточно звёзд' });
      db.users[me()].stars -= amount;
    }
    // durovv выдаёт звёзды: его баланс не уменьшается
    db.users[to].stars += amount;
    deliver({ id: crypto.randomUUID(), from: me(), to, text: '', amount, time: Date.now(), type: 'stars' });
    pushBalance(me());
    pushBalance(to);
    reply(cb, { ok: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server started on port ' + PORT));
