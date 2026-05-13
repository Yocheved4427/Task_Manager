'use strict';
require('dotenv').config();

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const { execFile } = require('child_process');
const multer     = require('multer');
const schedule   = require('node-schedule');
const webpush    = require('web-push');
const { v4: uuidv4 } = require('uuid');
const cors       = require('cors');
const admin      = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Firebase init ───────────────────────────────────────────────────────────
let serviceAccount;
if (process.env.fire_base) {
  serviceAccount = JSON.parse(process.env.fire_base);
} else {
  serviceAccount = require('./fire_base.json');
}
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db       = admin.firestore();
const tasksCol = db.collection('tasks');
const subsCol  = db.collection('subscriptions');

// ─── Web Push (VAPID) ────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@taskmanager.app', VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('VAPID keys not set – push notifications disabled.');
}

// ─── Directories ─────────────────────────────────────────────────────────────
const ICONS_DIR   = path.join(__dirname, 'public', 'icons');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(ICONS_DIR))   fs.mkdirSync(ICONS_DIR,   { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Multer ───────────────────────────────────────────────────────────────────
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename:    (_req, file,  cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, uuidv4() + ext);
    }
  }),
  limits:     { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    ALLOWED_MIMES.has(file.mimetype) ? cb(null, true) : cb(new Error('Only image files are allowed'));
  }
});

function deleteFromStorage(imageUrl) {
  if (!imageUrl) return;
  try {
    if (imageUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, 'public', imageUrl);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch { /* ignore */ }
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ─── Firestore helpers ───────────────────────────────────────────────────────
async function readTasks() {
  const snap = await tasksCol.get();
  return snap.docs.map(d => d.data());
}

async function saveTask(task) {
  await tasksCol.doc(task.id).set(task);
}

async function deleteTaskDoc(id) {
  await tasksCol.doc(id).delete();
}

async function getTask(id) {
  const doc = await tasksCol.doc(id).get();
  return doc.exists ? doc.data() : null;
}

// ─── Windows native toast notification ──────────────────────────────────────
function sendWindowsToast(task) {
  const title = `⏰ Task Due: ${task.title}`;
  const body  = task.description || 'This task is due now!';
  // Escape single quotes for PowerShell
  const safeTitle = title.replace(/'/g, "''");
  const safeBody  = body.replace(/'/g, "''");
  const ps = `Import-Module BurntToast -ErrorAction SilentlyContinue; ` +
             `New-BurntToastNotification -Text '${safeTitle}','${safeBody}' -AppLogo ''`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], err => {
    if (err) console.warn('Windows toast error:', err.message);
  });
}

// ─── Web Push notifications ─────────────────────────────────────────────────
async function sendWebPushToAll(task) {
  let snap;
  try { snap = await subsCol.get(); } catch { return; }
  const payload = JSON.stringify({
    title: `⏰ Task Due: ${task.title}`,
    body:  task.description || 'This task is due – tap to open.',
    tag:   task.id,
    taskId: task.id
  });
  snap.docs.forEach(async doc => {
    try {
      await webpush.sendNotification(doc.data(), payload);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await subsCol.doc(doc.id).delete(); // expired subscription
      } else {
        console.warn('Push error:', err.message);
      }
    }
  });
}

// ─── Scheduling ───────────────────────────────────────────────────────────────
const scheduledJobs    = {};
const overdueIntervals = {};
const OVERDUE_INTERVAL_MS = 5 * 60 * 1000;

function cancelTaskSchedule(taskId) {
  if (scheduledJobs[taskId])    { scheduledJobs[taskId].cancel();          delete scheduledJobs[taskId];    }
  if (overdueIntervals[taskId]) { clearInterval(overdueIntervals[taskId]); delete overdueIntervals[taskId]; }
}

function startOverdueInterval(task) {
  if (overdueIntervals[task.id]) return;
  sendWebPushToAll(task);
  sendWindowsToast(task);
  overdueIntervals[task.id] = setInterval(async () => {
    try {
      const current = await getTask(task.id);
      if (!current || current.status === 'done') {
        clearInterval(overdueIntervals[task.id]);
        delete overdueIntervals[task.id];
        return;
      }
      sendWebPushToAll(current);
      sendWindowsToast(current);
    } catch (err) {
      console.warn('Overdue interval error:', err.message);
    }
  }, OVERDUE_INTERVAL_MS);
}

function scheduleTask(task) {
  cancelTaskSchedule(task.id);
  if (task.status === 'done' || !task.scheduledAt) return;

  const dueDate = new Date(task.scheduledAt);
  if (isNaN(dueDate.getTime())) return;

  if (dueDate <= new Date()) {
    startOverdueInterval(task);
  } else {
    scheduledJobs[task.id] = schedule.scheduleJob(dueDate, async () => {
      try {
        const current = await getTask(task.id);
        if (current && current.status !== 'done') {
          startOverdueInterval(current);
          sendWindowsToast(current);
        }
      } catch (err) {
        console.warn('Schedule job error:', err.message);
      }
    });
  }
}

async function initSchedules() {
  const tasks  = await readTasks();
  const active = tasks.filter(t => t.status !== 'done');
  console.log(`Scheduling ${active.length} active task(s) from Firestore...`);
  active.forEach(t => scheduleTask(t));
}

// ─── API ─────────────────────────────────────────────────────────────────────

// GET /api/push/vapid-key
app.get('/api/push/vapid-key', (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// POST /api/push/subscribe
app.post('/api/push/subscribe', async (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  try {
    const id = Buffer.from(sub.endpoint).toString('base64url').slice(0, 64);
    await subsCol.doc(id).set(sub);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

app.get('/api/tasks', async (_req, res) => {
  try { res.json(await readTasks()); }
  catch (err) { res.status(500).json({ error: 'Failed to read tasks' }); }
});

app.post('/api/tasks', upload.single('image'), async (req, res) => {
  const { title, description, scheduledAt } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });

  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  const newTask  = {
    id:          uuidv4(),
    title:       title.trim().substring(0, 200),
    description: (description || '').substring(0, 2000),
    scheduledAt: scheduledAt || null,
    status:      'pending',
    imageUrl,
    createdAt:   new Date().toISOString(),
    completedAt: null
  };
  try {
    await saveTask(newTask);
    scheduleTask(newTask);
    res.status(201).json(newTask);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create task' });
  }
});

app.put('/api/tasks/:id', upload.single('image'), async (req, res) => {
  try {
    const old = await getTask(req.params.id);
    if (!old) return res.status(404).json({ error: 'Task not found' });

    const { title, description, scheduledAt, status, removeImage } = req.body;
    let imageUrl = old.imageUrl;
    if (removeImage === 'true') {
      deleteFromStorage(old.imageUrl);
      imageUrl = null;
    } else if (req.file) {
      deleteFromStorage(old.imageUrl);
      imageUrl = `/uploads/${req.file.filename}`;
    }

    const updated = {
      ...old,
      title:       title       ? title.trim().substring(0, 200)               : old.title,
      description: description !== undefined ? description.substring(0, 2000) : old.description,
      scheduledAt: scheduledAt !== undefined ? (scheduledAt || null)          : old.scheduledAt,
      status:      status || old.status,
      imageUrl,
      completedAt: (status === 'done' && !old.completedAt) ? new Date().toISOString() : old.completedAt
    };
    await saveTask(updated);
    scheduleTask(updated);
    res.json(updated);
  } catch (err) {
    console.error('PUT /api/tasks/:id error:', err);
    res.status(500).json({ error: 'Failed to update task', detail: err.message });
  }
});

app.patch('/api/tasks/:id/done', async (req, res) => {
  try {
    const old = await getTask(req.params.id);
    if (!old) return res.status(404).json({ error: 'Task not found' });
    const task = { ...old, status: 'done', completedAt: new Date().toISOString() };
    await saveTask(task);
    cancelTaskSchedule(task.id);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to mark task done' });
  }
});

app.patch('/api/tasks/:id/reopen', async (req, res) => {
  try {
    const old = await getTask(req.params.id);
    if (!old) return res.status(404).json({ error: 'Task not found' });
    const task = { ...old, status: 'pending', completedAt: null };
    await saveTask(task);
    scheduleTask(task);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to reopen task' });
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    deleteFromStorage(task.imageUrl);
    cancelTaskSchedule(task.id);
    await deleteTaskDoc(task.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('');
  console.log('  Task Manager is running!');
  console.log(`  Port: ${PORT}`);
  console.log('');
  await initSchedules();
});
