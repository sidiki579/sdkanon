# 💜 SDK Anon

Application de messages anonymes avec conversations en temps réel et messages éphémères.

---

## ✨ Fonctionnalités

- **Messages anonymes** : les visiteurs envoient des messages via ton lien — tu ne sais jamais qui
- **Conversations WhatsApp** : réponds à chaque anonyme dans un fil dédié
- **Messages éphémères** : supprimés automatiquement **5 minutes après lecture** (avec barre de progression visible)
- **Temps réel** : Socket.io pour les notifications instantanées
- **Inscription simple** : pseudo + nom + mot de passe

---

## 🆓 Stack 100% gratuite

| Composant | Technologie | Coût |
|-----------|-------------|------|
| Serveur | Node.js + Express + Socket.io | Gratuit |
| Base de données | SQLite (fichier local) | Gratuit |
| Hébergement | Render.com (free tier) | Gratuit |
| Frontend | HTML/CSS/JS pur | Gratuit |

> **Pourquoi SQLite ?** Zéro configuration, zéro coût, parfait pour démarrer.
> Quand tu auras des milliers d'utilisateurs, tu pourras migrer vers PostgreSQL.

---

## 🚀 Lancement en local

### 1. Installer les dépendances

```bash
cd server
npm install
```

### 2. Configurer l'environnement

```bash
cp .env.example .env
# Modifie JWT_SECRET dans .env avec une vraie chaîne aléatoire
```

### 3. Lancer le serveur

```bash
npm start
# ou pour le développement avec rechargement auto :
npm run dev
```

### 4. Ouvrir l'app

Visite `http://localhost:3000`

Pour partager ton lien : `http://localhost:3000/?u=ton_pseudo`

---

## ☁️ Déploiement GRATUIT sur Render.com

Render offre un free tier avec hébergement Node.js gratuit.

### Étape 1 — Préparer le projet sur GitHub

```bash
# Dans le dossier sdkanon/
git init
git add .
git commit -m "SDK Anon - première version"
```
Crée un dépôt sur github.com et push le code.

### Étape 2 — Déployer sur Render

1. Va sur **render.com** → créer un compte gratuit
2. Clique **"New Web Service"**
3. Connecte ton dépôt GitHub
4. Configure ainsi :
   - **Root Directory** : `server`
   - **Build Command** : `npm install`
   - **Start Command** : `node index.js`
   - **Plan** : Free

### Étape 3 — Variables d'environnement sur Render

Dans les settings de ton service Render, ajoute :
```
JWT_SECRET=une_longue_chaine_aleatoire_ici_minimum_32_caracteres
```

### Étape 4 — C'est en ligne ! 🎉

Render te donne une URL du type `https://sdkanon.onrender.com`

Ton lien à partager sera : `https://sdkanon.onrender.com/?u=ton_pseudo`

> ⚠️ **Note free tier Render** : le serveur "s'endort" après 15 min d'inactivité.
> Le premier chargement peut prendre ~30 secondes au réveil. C'est normal et gratuit.

---

## ⏱️ Comment fonctionnent les messages éphémères

1. Un anonyme t'envoie un message → stocké en base, non expiré
2. Tu ouvres la conversation → le serveur marque le message comme **vu**
3. Une `expires_at` est calculée : **heure de lecture + 5 minutes**
4. Une barre de progression s'affiche dans le chat (rouge quand < 1 min)
5. Toutes les 60 secondes, le serveur purge les messages expirés
6. Le message disparaît visuellement avec une animation douce

---

## 📁 Structure du projet

```
sdkanon/
├── server/
│   ├── index.js        ← Serveur principal
│   ├── package.json
│   ├── .env.example
│   └── sdkanon.db      ← Créé automatiquement au premier lancement
└── client/
    └── public/
        └── index.html  ← Toute l'interface (une seule page)
```

---

## 🔮 Améliorations futures (quand tu auras du budget)

- Notifications push (OneSignal — gratuit jusqu'à 10k users)
- Migrer SQLite → PostgreSQL (Supabase free tier)
- Domaine personnalisé (quelques euros/an)
- Modération des messages

---

## 💡 Astuce marketing

La fonctionnalité éphémère est un **argument de vente** :
*"Tes secrets sont en sécurité — les messages s'effacent après lecture"*
