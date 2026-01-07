# WhatsApp Bridge for Railway

Backend pentru conectarea la WhatsApp Web, folosit cu aplicația Lovable.

## ⚠️ IMPORTANT: Variabile de mediu necesare

În Railway Dashboard → Variables, adaugă această variabilă:

```
CALLBACK_URL=https://dutiqyqvlbolbasumcsr.supabase.co/functions/v1/whatsapp-callback
```

**Fără această variabilă, statusul nu se va actualiza automat când scanezi QR-ul!**

---

## Cum să faci deploy pe Railway

### Pasul 1: Creează un repository GitHub nou
1. Creează un repo nou pe GitHub (ex: `whatsapp-bridge`)
2. Încarcă cele 4 fișiere din acest folder:
   - `package.json`
   - `index.js`
   - `Dockerfile`
   - `README.md`

### Pasul 2: Deploy pe Railway
1. Mergi la [railway.app](https://railway.app)
2. Click **New Project** → **Deploy from GitHub repo**
3. Selectează repo-ul creat
4. Railway va detecta automat Dockerfile-ul și va face deploy

### Pasul 3: Configurare
1. După deploy, copiază URL-ul public (ex: `https://xyz.up.railway.app`)
2. În Railway, adaugă variabila `CALLBACK_URL` (vezi mai sus)
3. În aplicația Lovable, actualizează secretul `WHATSAPP_BRIDGE_URL` cu URL-ul Railway
   - ⚠️ Asigură-te că include `https://` la început!

## Endpoints API

| Endpoint | Metodă | Descriere |
|----------|--------|-----------|
| `/health` | GET | Health check |
| `/api/get-qr` | POST | Obține QR code pentru conectare |
| `/api/status` | POST | Verifică statusul conexiunii |
| `/api/disconnect` | POST | Deconectează WhatsApp |
| `/api/send-message` | POST | Trimite mesaj |

## Parametri

### POST /api/get-qr
```json
{
  "connection_id": "uuid-xxxxx",
  "instance_id": "uuid-xxxxx",
  "token": "xxxxx",
  "webhook_url": "https://your-server.com/webhook"
}
```

**Notă:** `connection_id` și `instance_id` sunt acceptate ambele pentru backwards compatibility.

### POST /api/send-message
```json
{
  "connection_id": "uuid-xxxxx",
  "to": "40712345678",
  "message": "Hello!",
  "type": "text"
}
```

## Răspunsuri

### QR Ready
```json
{
  "qr": "data:image/png;base64,...",
  "status": "qr_pending"
}
```

### Still Loading
```json
{
  "status": "pending"
}
```

### Connected
```json
{
  "status": "connected",
  "phone_number": "40712345678"
}
```

## Troubleshooting

### Dacă QR-ul nu apare:
- Așteaptă 10-30 secunde la primul request (Chromium trebuie să pornească)
- Verifică logurile în Railway pentru erori

### Dacă primești erori de memorie:
- Upgrade la un plan Railway cu mai multă memorie (min 512MB recomandat)

### Sesiunea expiră:
- Sesiunile sunt salvate în `/app/.wwebjs_auth`
- Pentru persistență, poți atașa un volum în Railway
