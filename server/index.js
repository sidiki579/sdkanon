require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sdkanon_secret_change_en_prod';
const MSG_TTL_MS = 5 * 60 * 1000;

// ── CONNEXION POSTGRESQL (Supabase) ───────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      anon_token TEXT UNIQUE NOT NULL,
      anon_label TEXT NOT NULL,
      created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      from_anon INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      sent_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      seen_at BIGINT DEFAULT NULL,
      expires_at BIGINT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_msg_exp ON messages(expires_at);
  `);
  console.log('💾 Base de données Supabase prête');
}

// Purge des messages expirés toutes les 60 secondes
async function purgeExpired() {
  const now = Math.floor(Date.now() / 1000);
  const res = await query('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= $1', [now]);
  if (res.rowCount > 0) console.log(`🗑️  ${res.rowCount} message(s) expirés supprimés`);
}
setInterval(purgeExpired, 60000);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

function authMW(req, res, next) {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ error: 'Token manquant' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token invalide' }); }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, display_name, password } = req.body;
    if (!username || !display_name || !password) return res.status(400).json({ error: 'Champs manquants' });
    const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (clean.length < 3) return res.status(400).json({ error: 'Pseudo trop court (min 3 car.)' });
    const exists = await query('SELECT id FROM users WHERE username = $1', [clean]);
    if (exists.rows.length) return res.status(400).json({ error: 'Pseudo déjà pris' });
    const id = uuidv4(), hash = bcrypt.hashSync(password, 10);
    await query('INSERT INTO users (id, username, display_name, password_hash) VALUES ($1,$2,$3,$4)', [id, clean, display_name, hash]);
    const token = jwt.sign({ id, username: clean, display_name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, username: clean, display_name } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const clean = req.body.username?.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const r = await query('SELECT * FROM users WHERE username = $1', [clean]);
    const user = r.rows[0];
    if (!user || !bcrypt.compareSync(req.body.password, user.password_hash))
      return res.status(401).json({ error: 'Identifiants incorrects' });
    const token = jwt.sign({ id: user.id, username: user.username, display_name: user.display_name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, username: user.username, display_name: user.display_name } });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── CONVERSATIONS ─────────────────────────────────────────────────────────────
app.get('/api/conversations', authMW, async (req, res) => {
  try {
    const r = await query(`
      SELECT c.id, c.anon_label, c.anon_token, c.created_at,
        (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY sent_at DESC LIMIT 1) as last_msg,
        (SELECT sent_at FROM messages WHERE conversation_id=c.id ORDER BY sent_at DESC LIMIT 1) as last_time,
        (SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND from_anon=1 AND seen_at IS NULL)::int as unread
      FROM conversations c WHERE c.owner_id=$1 ORDER BY last_time DESC NULLS LAST
    `, [req.user.id]);
    res.json(r.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── MESSAGES OWNER ────────────────────────────────────────────────────────────
app.get('/api/conversations/:cid/messages', authMW, async (req, res) => {
  try {
    const conv = await query('SELECT * FROM conversations WHERE id=$1 AND owner_id=$2', [req.params.cid, req.user.id]);
    if (!conv.rows.length) return res.status(403).json({ error: 'Accès refusé' });
    const c = conv.rows[0];
    const now = Math.floor(Date.now() / 1000);
    const msgs = await query('SELECT * FROM messages WHERE conversation_id=$1 AND (expires_at IS NULL OR expires_at>$2) ORDER BY sent_at ASC', [req.params.cid, now]);
    const unread = msgs.rows.filter(m => m.from_anon && !m.seen_at);
    if (unread.length) {
      const exp = Math.floor((Date.now() + MSG_TTL_MS) / 1000);
      for (const m of unread) {
        await query('UPDATE messages SET seen_at=$1, expires_at=$2 WHERE id=$3 AND seen_at IS NULL', [now, exp, m.id]);
        m.expires_at = exp;
        io.to('user_' + req.user.id).emit('message_timer_started', { messageId: m.id, expiresAt: exp * 1000 });
      }
    }
    res.json(msgs.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/conversations/:cid/messages', authMW, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });
    const conv = await query('SELECT * FROM conversations WHERE id=$1 AND owner_id=$2', [req.params.cid, req.user.id]);
    if (!conv.rows.length) return res.status(403).json({ error: 'Accès refusé' });
    const c = conv.rows[0];
    const now = Math.floor(Date.now() / 1000), id = uuidv4();
    await query('INSERT INTO messages (id,conversation_id,from_anon,content,sent_at) VALUES($1,$2,0,$3,$4)', [id, req.params.cid, content.trim(), now]);
    const msg = { id, conversation_id: req.params.cid, from_anon: 0, content: content.trim(), sent_at: now };
    io.to('anon_' + c.anon_token).emit('owner_reply', { ...msg, sent_at: now * 1000 });
    res.json(msg);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── ROUTES ANONYMES ───────────────────────────────────────────────────────────
app.get('/api/anon/profile/:username', async (req, res) => {
  try {
    const r = await query('SELECT id,username,display_name FROM users WHERE username=$1', [req.params.username.toLowerCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Introuvable' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/anon/send/:username', async (req, res) => {
  try {
    const { content, anon_token } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });
    const owner = await query('SELECT id FROM users WHERE username=$1', [req.params.username.toLowerCase()]);
    if (!owner.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const ownerId = owner.rows[0].id;
    let conv = null;
    if (anon_token) {
      const r = await query('SELECT * FROM conversations WHERE anon_token=$1 AND owner_id=$2', [anon_token, ownerId]);
      conv = r.rows[0] || null;
    }
    if (!conv) {
      const emojis = ['🦋','🌙','🔮','👾','🎭','🌸','⚡','🦊','🎪','🌊','🐺','🦅','🎯','🔥','💎'];
      const label = emojis[Math.floor(Math.random()*emojis.length)] + ' #' + Math.random().toString(36).substring(2,5).toUpperCase();
      const cid = uuidv4(), tok = uuidv4();
      await query('INSERT INTO conversations (id,owner_id,anon_token,anon_label) VALUES($1,$2,$3,$4)', [cid, ownerId, tok, label]);
      conv = { id: cid, owner_id: ownerId, anon_token: tok, anon_label: label };
    }
    const now = Math.floor(Date.now() / 1000), mid = uuidv4();
    await query('INSERT INTO messages (id,conversation_id,from_anon,content,sent_at) VALUES($1,$2,1,$3,$4)', [mid, conv.id, content.trim(), now]);
    const msg = { id: mid, conversation_id: conv.id, from_anon: 1, content: content.trim(), sent_at: now };
    io.to('user_' + ownerId).emit('new_conversation_or_message', { convId: conv.id, anonLabel: conv.anon_label, message: { ...msg, sent_at: now * 1000 } });
    res.json({ anon_token: conv.anon_token, conv_id: conv.id, msg_id: mid });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/anon/reply', async (req, res) => {
  try {
    const { content, anon_token, conv_id } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Message vide' });
    const r = await query('SELECT * FROM conversations WHERE id=$1 AND anon_token=$2', [conv_id, anon_token]);
    if (!r.rows.length) return res.status(403).json({ error: 'Token invalide' });
    const conv = r.rows[0];
    const now = Math.floor(Date.now() / 1000), mid = uuidv4();
    await query('INSERT INTO messages (id,conversation_id,from_anon,content,sent_at) VALUES($1,$2,1,$3,$4)', [mid, conv.id, content.trim(), now]);
    const msg = { id: mid, conversation_id: conv.id, from_anon: 1, content: content.trim(), sent_at: now };
    io.to('user_' + conv.owner_id).emit('new_conversation_or_message', { convId: conv.id, anonLabel: conv.anon_label, message: { ...msg, sent_at: now * 1000 } });
    res.json({ ...msg, sent_at: now * 1000 });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/anon/conv-info/:conv_id', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    const r = await query('SELECT * FROM conversations WHERE id=$1 AND anon_token=$2', [req.params.conv_id, token]);
    if (!r.rows.length) return res.status(403).json({ error: 'Token invalide' });
    const conv = r.rows[0];
    const now = Math.floor(Date.now() / 1000);
    const last = await query('SELECT content,sent_at FROM messages WHERE conversation_id=$1 AND (expires_at IS NULL OR expires_at>$2) ORDER BY sent_at DESC LIMIT 1', [req.params.conv_id, now]);
    const unread = await query('SELECT COUNT(*)::int as cnt FROM messages WHERE conversation_id=$1 AND from_anon=0 AND seen_at IS NULL', [req.params.conv_id]);
    const owner = await query('SELECT username,display_name FROM users WHERE id=$1', [conv.owner_id]);
    res.json({
      id: conv.id, anon_label: conv.anon_label, anon_token: conv.anon_token,
      owner_username: owner.rows[0]?.username || '',
      owner_name: owner.rows[0]?.display_name || '',
      last_msg: last.rows[0]?.content || null,
      last_time: last.rows[0]?.sent_at || conv.created_at,
      unread: unread.rows[0]?.cnt || 0,
      _sent_by_me: true
    });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/anon/messages/:conv_id', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    const r = await query('SELECT * FROM conversations WHERE id=$1 AND anon_token=$2', [req.params.conv_id, token]);
    if (!r.rows.length) return res.status(403).json({ error: 'Token invalide' });
    const conv = r.rows[0];
    const now = Math.floor(Date.now() / 1000);
    const msgs = await query('SELECT * FROM messages WHERE conversation_id=$1 AND (expires_at IS NULL OR expires_at>$2) ORDER BY sent_at ASC', [req.params.conv_id, now]);
    const unread = msgs.rows.filter(m => !m.from_anon && !m.seen_at);
    if (unread.length) {
      const exp = Math.floor((Date.now() + MSG_TTL_MS) / 1000);
      for (const m of unread) {
        await query('UPDATE messages SET seen_at=$1, expires_at=$2 WHERE id=$3 AND seen_at IS NULL', [now, exp, m.id]);
        m.expires_at = exp;
        io.to('anon_' + token).emit('message_timer_started', { messageId: m.id, expiresAt: exp * 1000 });
      }
    }
    res.json(msgs.rows);
  } catch(e) { console.error(e); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const t = socket.handshake.auth.token;
  const at = socket.handshake.auth.anon_token;
  if (t) {
    try { socket.user = jwt.verify(t, JWT_SECRET); socket.roomId = 'user_' + socket.user.id; }
    catch { return next(new Error('Token invalide')); }
  } else if (at) {
    socket.roomId = 'anon_' + at;
  } else {
    return next(new Error('Auth requise'));
  }
  next();
});

io.on('connection', socket => {
  socket.join(socket.roomId);
  console.log('✅ Connecté:', socket.roomId);
  socket.on('disconnect', () => console.log('❌ Déconnecté:', socket.roomId));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../client/public/index.html')));

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────
initDB().then(() => {
  purgeExpired();
  server.listen(PORT, () => {
    console.log(`\n🚀 SDK Anon → http://localhost:${PORT}`);
    console.log(`🗄️  Base : Supabase PostgreSQL`);
    console.log(`⏱️  Messages éphémères : 5 min après lecture\n`);
  });
}).catch(e => {
  console.error('❌ Erreur connexion base de données:', e.message);
  process.exit(1);
});