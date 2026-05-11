require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sdkanon_secret_change_in_prod';
const MSG_TTL_MS = 5 * 60 * 1000;
const DB_PATH = path.join(__dirname, 'sdkanon.db.bin');

let DB;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    DB = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('💾 Base chargée depuis disque');
  } else {
    DB = new SQL.Database();
    console.log('💾 Nouvelle base créée');
  }
  DB.run(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, anon_token TEXT UNIQUE NOT NULL, anon_label TEXT NOT NULL, created_at INTEGER DEFAULT (strftime('%s','now')));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, from_anon INTEGER NOT NULL DEFAULT 0, content TEXT NOT NULL, sent_at INTEGER DEFAULT (strftime('%s','now')), seen_at INTEGER DEFAULT NULL, expires_at INTEGER DEFAULT NULL);
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_msg_exp ON messages(expires_at);
  `);
  saveDB();
}

function saveDB() { fs.writeFileSync(DB_PATH, Buffer.from(DB.export())); }
setInterval(saveDB, 30000);

function dbGet(sql, p=[]) { const s=DB.prepare(sql); s.bind(p); const r=s.step()?s.getAsObject():null; s.free(); return r; }
function dbAll(sql, p=[]) { const rows=[],s=DB.prepare(sql); s.bind(p); while(s.step()) rows.push(s.getAsObject()); s.free(); return rows; }
function dbRun(sql, p=[]) { DB.run(sql,p); }

function purgeExpired() {
  const now=Math.floor(Date.now()/1000);
  const old=dbAll('SELECT id FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?',[now]);
  if(old.length){ dbRun('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at<=?',[now]); saveDB(); console.log(`🗑️  ${old.length} msg(s) supprimé(s)`); }
}
setInterval(purgeExpired, 60000);

app.use(cors()); app.use(express.json());
app.use(express.static(path.join(__dirname,'../client/public')));

function auth(req,res,next){ const t=req.headers.authorization?.split(' ')[1]; if(!t) return res.status(401).json({error:'Token manquant'}); try{ req.user=jwt.verify(t,JWT_SECRET); next(); }catch{ res.status(401).json({error:'Token invalide'}); } }

app.post('/api/register',(req,res)=>{
  const {username,display_name,password}=req.body;
  if(!username||!display_name||!password) return res.status(400).json({error:'Champs manquants'});
  const clean=username.toLowerCase().replace(/[^a-z0-9_]/g,'');
  if(clean.length<3) return res.status(400).json({error:'Pseudo trop court'});
  if(dbGet('SELECT id FROM users WHERE username=?',[clean])) return res.status(400).json({error:'Pseudo déjà pris'});
  const id=uuidv4(),hash=bcrypt.hashSync(password,10);
  dbRun('INSERT INTO users (id,username,display_name,password_hash) VALUES(?,?,?,?)',[id,clean,display_name,hash]); saveDB();
  const token=jwt.sign({id,username:clean,display_name},JWT_SECRET,{expiresIn:'30d'});
  res.json({token,user:{id,username:clean,display_name}});
});

app.post('/api/login',(req,res)=>{
  const clean=req.body.username?.toLowerCase().replace(/[^a-z0-9_]/g,'');
  const user=dbGet('SELECT * FROM users WHERE username=?',[clean]);
  if(!user||!bcrypt.compareSync(req.body.password,user.password_hash)) return res.status(401).json({error:'Identifiants incorrects'});
  const token=jwt.sign({id:user.id,username:user.username,display_name:user.display_name},JWT_SECRET,{expiresIn:'30d'});
  res.json({token,user:{id:user.id,username:user.username,display_name:user.display_name}});
});

app.get('/api/conversations',auth,(req,res)=>{
  const convs=dbAll(`SELECT c.id,c.anon_label,c.anon_token,c.created_at,(SELECT content FROM messages WHERE conversation_id=c.id ORDER BY sent_at DESC LIMIT 1) as last_msg,(SELECT sent_at FROM messages WHERE conversation_id=c.id ORDER BY sent_at DESC LIMIT 1) as last_time,(SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND from_anon=1 AND seen_at IS NULL) as unread FROM conversations c WHERE c.owner_id=? ORDER BY last_time DESC`,[req.user.id]);
  res.json(convs);
});

app.get('/api/conversations/:cid/messages',auth,(req,res)=>{
  const conv=dbGet('SELECT * FROM conversations WHERE id=? AND owner_id=?',[req.params.cid,req.user.id]);
  if(!conv) return res.status(403).json({error:'Accès refusé'});
  const now=Math.floor(Date.now()/1000);
  const msgs=dbAll('SELECT * FROM messages WHERE conversation_id=? AND (expires_at IS NULL OR expires_at>?) ORDER BY sent_at ASC',[req.params.cid,now]);
  const unread=msgs.filter(m=>m.from_anon&&!m.seen_at);
  if(unread.length){
    const exp=Math.floor((Date.now()+MSG_TTL_MS)/1000);
    unread.forEach(m=>{ dbRun('UPDATE messages SET seen_at=?,expires_at=? WHERE id=? AND seen_at IS NULL',[now,exp,m.id]); m.expires_at=exp; io.to(`user_${req.user.id}`).emit('message_timer_started',{messageId:m.id,expiresAt:exp*1000}); });
    saveDB();
  }
  res.json(msgs);
});

app.post('/api/conversations/:cid/messages',auth,(req,res)=>{
  const {content}=req.body;
  if(!content?.trim()) return res.status(400).json({error:'Message vide'});
  const conv=dbGet('SELECT * FROM conversations WHERE id=? AND owner_id=?',[req.params.cid,req.user.id]);
  if(!conv) return res.status(403).json({error:'Accès refusé'});
  const now=Math.floor(Date.now()/1000),id=uuidv4();
  dbRun('INSERT INTO messages (id,conversation_id,from_anon,content,sent_at) VALUES(?,?,0,?,?)',[id,req.params.cid,content.trim(),now]); saveDB();
  const msg={id,conversation_id:req.params.cid,from_anon:0,content:content.trim(),sent_at:now};
  io.to(`anon_${conv.anon_token}`).emit('new_message',{...msg,sent_at:now*1000});
  res.json(msg);
});

app.get('/api/anon/profile/:u',(req,res)=>{
  const user=dbGet('SELECT id,username,display_name FROM users WHERE username=?',[req.params.u.toLowerCase()]);
  if(!user) return res.status(404).json({error:'Introuvable'});
  res.json(user);
});

app.post('/api/anon/send/:u',(req,res)=>{
  const {content,anon_token}=req.body;
  if(!content?.trim()) return res.status(400).json({error:'Message vide'});
  const user=dbGet('SELECT id FROM users WHERE username=?',[req.params.u.toLowerCase()]);
  if(!user) return res.status(404).json({error:'Introuvable'});
  let conv=anon_token?dbGet('SELECT * FROM conversations WHERE anon_token=? AND owner_id=?',[anon_token,user.id]):null;
  if(!conv){
    const emojis=['🦋','🌙','🔮','👾','🎭','🌸','⚡','🦊','🎪','🌊','🐺','🦅'];
    const label=emojis[Math.floor(Math.random()*emojis.length)]+' #'+Math.random().toString(36).substring(2,5).toUpperCase();
    const cid=uuidv4(),tok=uuidv4();
    dbRun('INSERT INTO conversations (id,owner_id,anon_token,anon_label) VALUES(?,?,?,?)',[cid,user.id,tok,label]);
    conv={id:cid,owner_id:user.id,anon_token:tok,anon_label:label};
  }
  const now=Math.floor(Date.now()/1000),mid=uuidv4();
  dbRun('INSERT INTO messages (id,conversation_id,from_anon,content,sent_at) VALUES(?,?,1,?,?)',[mid,conv.id,content.trim(),now]); saveDB();
  io.to(`user_${user.id}`).emit('new_conversation_or_message',{convId:conv.id,anonLabel:conv.anon_label,message:{id:mid,conversation_id:conv.id,from_anon:1,content:content.trim(),sent_at:now*1000}});
  res.json({anon_token:conv.anon_token,message:'Envoyé !'});
});

io.use((socket,next)=>{
  const t=socket.handshake.auth.token,at=socket.handshake.auth.anon_token;
  if(t){ try{ socket.user=jwt.verify(t,JWT_SECRET); socket.roomId=`user_${socket.user.id}`; }catch{ return next(new Error('Token invalide')); } }
  else if(at){ socket.roomId=`anon_${at}`; }
  else return next(new Error('Auth requise'));
  next();
});
io.on('connection',s=>{ s.join(s.roomId); console.log('✅',s.roomId); s.on('disconnect',()=>console.log('❌',s.roomId)); });

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'../client/public/index.html')));

initDB().then(()=>{ purgeExpired(); server.listen(PORT,()=>{ console.log(`\n🚀 SDK Anon → http://localhost:${PORT}`); console.log(`⏱️  Ephémère: 5 min après lecture\n`); }); });