# Task Manager PWA

A task-management web app that installs as a Progressive Web App and sends reminders as push notifications. Tasks are stored in Firebase Firestore.

## Features

- Installable PWA (web manifest and service worker)
- Tasks stored in Firestore
- Scheduled reminders with `node-schedule`, delivered through Web Push (VAPID)
- File upload support (multer)
- Windows helper scripts to start the server in the background and to add or remove it from autostart

## Run it

```bash
npm install
npm start
```

Configuration is read from environment variables (a `.env` file works):

| Variable | Purpose |
|---|---|
| `fire_base` | Firebase service-account JSON (or place it in `fire_base.json`, which must not be committed) |
| `VAPID_PUBLIC`, `VAPID_PRIVATE` | Web Push keys; without them push notifications are disabled |
| `PORT` | Server port (default 3000) |

Windows: `start.bat`, `stop.bat`, `start-background.vbs`, `install-autostart.bat`, `uninstall-autostart.bat`.

## Tech

Node.js, Express, Firebase Admin / Firestore, web-push, node-schedule, multer, vanilla JavaScript.
