# Aula

Open source, self-hosted alternative to Google Classroom. One Node script, one SQLite file, one folder of uploads. No npm dependencies (Node >= 22.5).

- Teachers create classes and share a 6-character join code.
- Announcements and assignments (due date, points, attachments).
- Students write answers, attach files, turn in / unsubmit.
- Teachers see turned-in work (drafts stay private), grade with feedback; graded work is locked.

```bash
npm start        # http://127.0.0.1:8788
npm test
```

| Env var | Default | |
|---|---|---|
| `PORT` / `HOST` | `8788` / `127.0.0.1` | listen address |
| `AULA_DATA` | `./data` | `aula.db` + `files/`: back it up |
| `AULA_REGISTRATION` | `open` | `closed` once your users exist |
| `AULA_MAX_UPLOAD` | 25 MB | per file, bytes |

Put HTTPS (Caddy, nginx) in front before exposing it. API is plain JSON with `Authorization: Bearer <token>`; see `server.js`.

## Known limits

- One teacher per class (the creator), no co-teachers, no leaving/removing members.
- No email, notifications, comments, rubrics, per-user upload quota or password reset.
- Login throttle is in memory (resets on restart).
- English-only UI.
