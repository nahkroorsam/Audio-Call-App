# AudioCall – Group Voice (Supabase + Netlify)

Secure web-based **audio-only** group calling (up to 10 people).  
Features:

- Email + password signup with **email confirmation**
- **Google OAuth** login
- Generate shareable call link
- Push-to-Talk + Mute
- Light theme, no chat / no emojis
- Real WebRTC mesh + Supabase Realtime signaling

---

## Project structure

```
audiocall/
├── index.html              # Main UI
├── css/styles.css
├── js/
│   ├── supabaseClient.js   # Supabase init
│   ├── auth.js             # Login / signup / Google
│   ├── call.js             # WebRTC + Realtime signaling
│   └── app.js              # App orchestration
├── supabase/
│   └── schema.sql          # Database + RLS policies
├── netlify.toml
├── .env.example
└── README.md
```

---

## 1. Create a Supabase project

1. Go to [https://supabase.com](https://supabase.com) → New project
2. Wait until the project is ready
3. Copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY`  
     (Settings → API)

### Enable Auth providers

**Email / Password**
- Authentication → Providers → Email → Enable
- Turn **ON** “Confirm email” (this is the Google-mail confirmation you asked for)

**Google**
1. Authentication → Providers → Google → Enable
2. Create OAuth credentials in [Google Cloud Console](https://console.cloud.google.com/):
   - Create a project (or use existing)
   - APIs & Services → Credentials → Create OAuth client ID
   - Application type: **Web application**
   - Authorized JavaScript origins:
     - `http://localhost:5500` (or whatever port you use locally)
     - `https://YOUR-SITE.netlify.app`
   - Authorized redirect URIs:
     - `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
3. Paste Client ID + Client Secret into Supabase Google provider settings
4. Save

### Run the database schema

1. Supabase Dashboard → **SQL Editor**
2. Paste the contents of `supabase/schema.sql`
3. Run it

This creates:
- `profiles` table (auto-filled on signup)
- `rooms` table (optional, for ownership / expiry)
- Row Level Security policies

### Realtime

Realtime Broadcast + Presence are enabled by default.  
No extra configuration needed for the signaling channels we use.

---

## 2. Configure the frontend

Open `index.html` and replace the placeholder values:

```js
window.ENV = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
};
```

Or leave them as placeholders and inject via Netlify environment variables (recommended).

---

## 3. Deploy to Netlify

### Option A – Drag & drop
1. Zip the whole `audiocall` folder (or just the files inside it)
2. Go to [https://app.netlify.com](https://app.netlify.com) → Sites → “Add new site” → Deploy manually
3. Drop the folder

### Option B – Git
1. Push the folder to a GitHub/GitLab/Bitbucket repo
2. Netlify → New site from Git → select the repo
3. Build settings:
   - Build command: *(leave empty)*
   - Publish directory: `.` (or the folder that contains `index.html`)

### Environment variables (important)

In Netlify → Site settings → Environment variables add:

| Key                 | Value                          |
|---------------------|--------------------------------|
| `SUPABASE_URL`      | your project URL               |
| `SUPABASE_ANON_KEY` | your anon key                  |

Then, to inject them into the page at build time you can either:

**Simple method (recommended for this project)**  
Edit `index.html` once with the real values (they are public anon keys anyway).

**Or use a Netlify build plugin / snippet** to replace placeholders.

After deploy, update the Google OAuth redirect URIs and JavaScript origins with your real Netlify domain (`https://something.netlify.app`).

Also add the same domain under Supabase → Authentication → URL Configuration:
- Site URL: `https://YOUR-SITE.netlify.app`
- Redirect URLs: `https://YOUR-SITE.netlify.app/**`

---

## 4. Local testing

1. Put your real `SUPABASE_URL` and `SUPABASE_ANON_KEY` into `index.html` (`window.ENV`)
2. Serve the folder with any static server, e.g.:

```bash
npx serve .
# or
python -m http.server 5500
```

3. Open `http://localhost:5500`
4. Allow microphone when prompted

> **Note**: Some browsers require HTTPS for `getUserMedia` except on localhost.

---

## 5. How it works

| Feature              | Implementation                                      |
|----------------------|-----------------------------------------------------|
| Auth                 | Supabase Auth (email confirmation + Google OAuth)   |
| Room discovery       | Short random code + shareable `?room=CODE` link     |
| Signaling            | Supabase Realtime Broadcast + Presence              |
| Media                | Native WebRTC (mesh, audio only)                    |
| Mute / Push-to-Talk  | Enable/disable local audio tracks                   |
| Max participants     | Enforced client-side (10)                           |
| Hosting              | Netlify (static)                                    |

---

## 6. Production tips

- The free PeerJS public server is **not** used. All signaling goes through your Supabase project.
- Mesh topology is fine for ≤ 10 audio participants. For larger groups consider an SFU (LiveKit, Daily, Mediasoup).
- Turn on Supabase “Confirm email” so only verified addresses can log in.
- You can add rate limiting / room expiry by querying the `rooms` table.
- For better NAT traversal you can add TURN servers (e.g. Metered.ca free tier or Twilio) in `js/call.js` → `ICE_SERVERS`.

---

## 7. Troubleshooting

| Problem                        | Fix                                                                 |
|--------------------------------|---------------------------------------------------------------------|
| “Invalid login credentials”    | Confirm the email first (check inbox + spam)                        |
| Google login redirects wrongly | Check Site URL + Redirect URLs in Supabase Auth settings            |
| No audio / mic denied          | Must be HTTPS (or localhost). Check browser permissions             |
| Peers cannot hear each other   | Open browser console – look for ICE / signaling errors              |
| Room full                      | Max 10 enforced in `call.js`                                        |

---

Enjoy your private group audio calls!
