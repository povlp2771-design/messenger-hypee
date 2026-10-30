const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ADMIN = 'durovv';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const COLORS = ['#2b8fd9', '#e5484d', '#30a46c', '#f5a623', '#8e4ec6', '#e93d82', '#12a594', '#6e7781'];
const GIFTS = [
  { id: 'heart', emoji: '❤️', name: 'Сердце', price: 15 },
  { id: 'bear', emoji: '🧸', name: 'Мишка', price: 25 },
  { id: 'rose', emoji: '🌹', name: 'Роза', price: 50 },
  { id: 'cake', emoji: '🎂', name: 'Торт', price: 50 },
  { id: 'rocket', emoji: '🚀', name: 'Ракета', price: 100 },
  { id: 'cup', emoji: '🏆', name: 'Кубок', price: 100 },
  { id: 'ring', emoji: '💍', name: 'Кольцо', price: 150 },
  { id: 'diamond', emoji: '💎', name: 'Бриллиант', price: 250 }
];

let db = { users: {}, messages: [], tokens: {} };

async function load() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS store (id INT PRIMARY KEY, data JSONB NOT NULL)');
    const r = await pool.query('SELECT data FROM store WHERE id = 1');
    if (r.rows.length) db = r.rows[0].data;
  } else {
    try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
  }
  db.users = db.users || {};
  db.messages = db.messages || [];
  db.tokens = db.tokens || {};
}

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    try {
      if (pool) {
        await pool.query(
          'INSERT INTO store (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET data = $1::jsonb',
          [JSON.stringify(db)]
        );
      } else {
        fs.writeFileSync(DATA_FILE, JSON.stringify(db));
      }
    } catch (e) { console.error('save error', e.message); }
  }, 500);
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
  s = String( 
