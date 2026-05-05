/* global API, Notification */
'use strict';

// ── State ────────────────────────────────────────────────────────
let tasks          = [];
let currentFilter  = 'pending';
let editingTaskId  = null;
let pendingRemoveImage = false;

// ── Helpers ──────────────────────────────────────────────────────
function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function isOverdue(task) {
  return task.status !== 'done' && task.scheduledAt && new Date(task.scheduledAt) < new Date();
}

function getStatus(task) {
  if (task.status === 'done') return 'done';
  if (isOverdue(task))        return 'overdue';
  return 'pending';
}

// ── Toast ────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span>
                     <span>${escapeHtml(message)}</span>`;
  document.getElementById('toast-container').appendChild(toast);
  setTimeout(() => {
    toast.style.opacity  = '0';
    toast.style.transform = 'translateX(110%)';
    setTimeout(() => toast.remove(), 320);
  }, 3500);
}

// ── Browser Notifications ────────────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('Notifications not supported in this browser', 'warning');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    showToast('Desktop notifications enabled!', 'success');
    document.getElementById('notif-btn').hidden = true;
    startNotificationPoller();
  } else {
    showToast('Notification permission denied', 'error');
  }
}

function sendBrowserNotification(task) {
  if (Notification.permission !== 'granted') return;
  // Use the service worker to show the notification so clicks work
  // even when the page is closed or in the background.
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification(`⏰ Task Due: ${task.title}`, {
        body:              task.description || 'This task is due now!',
        icon:              '/icons/icon.svg',
        tag:               task.id,
        requireInteraction: true,
        data:              { taskId: task.id },
        actions: [
          { action: 'done',       title: '✓ Done'       },
          { action: 'try-later',  title: '⏰ Try Later'  }
        ]
      });
    });
  } else {
    // Fallback for when service worker is not yet controlling the page
    const n = new Notification(`⏰ Task Due: ${task.title}`, {
      body:              task.description || 'This task is due now!',
      icon:              '/icons/icon.svg',
      tag:               task.id,
      requireInteraction: true
    });
    n.onclick = () => { window.focus(); openDetailModal(task.id); n.close(); };
  }
}

function snoozeTask(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  showToast(`"${task.title}" snoozed for 30 minutes`, 'info');
  setTimeout(() => {
    const t = tasks.find(x => x.id === taskId);
    if (t && t.status !== 'done') sendBrowserNotification(t);
  }, 30 * 60 * 1000);
}

// Listen for messages from the service worker (e.g. open a specific task)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (!event.data) return;
    if (event.data.type === 'openTask' && event.data.taskId) {
      openDetailModal(event.data.taskId);
    }
    if (event.data.type === 'refreshTasks') {
      API.getTasks().then(data => { tasks = data; renderTasks(); }).catch(() => {});
    }
    if (event.data.type === 'snoozeTask' && event.data.taskId) {
      snoozeTask(event.data.taskId);
    }
  });
}

// Poll every 30 s for tasks that just crossed their due time
let notifPoller = null;
const notifiedIds = new Set();

function startNotificationPoller() {
  if (notifPoller) return;
  notifPoller = setInterval(() => {
    const now = Date.now();
    tasks.forEach(task => {
      if (task.status === 'done' || !task.scheduledAt) return;
      const dueMs = new Date(task.scheduledAt).getTime();
      const diff  = now - dueMs;
      // Trigger once when within 30s after the due time
      if (diff >= 0 && diff < 30_000 && !notifiedIds.has(task.id)) {
        notifiedIds.add(task.id);
        sendBrowserNotification(task);
      }
    });
  }, 15_000);
}

// ── Stats ────────────────────────────────────────────────────────
function updateStats() {
  const now = new Date();
  let pending = 0, overdue = 0, done = 0;
  tasks.forEach(t => {
    if (t.status === 'done') done++;
    else if (t.scheduledAt && new Date(t.scheduledAt) < now) overdue++;
    else pending++;
  });
  document.getElementById('stat-total').textContent   = tasks.length;
  document.getElementById('stat-pending').textContent = pending;
  document.getElementById('stat-overdue').textContent = overdue;
  document.getElementById('stat-done').textContent    = done;
}

// ── Render ───────────────────────────────────────────────────────
function getFilteredTasks() {
  const now = new Date();
  switch (currentFilter) {
    case 'pending':
      return tasks.filter(t => t.status !== 'done' && (!t.scheduledAt || new Date(t.scheduledAt) >= now));
    case 'overdue':
      return tasks.filter(t => t.status !== 'done' && t.scheduledAt && new Date(t.scheduledAt) < now);
    case 'done':
      return tasks.filter(t => t.status === 'done');
    default:
      return [...tasks];
  }
}

function renderTasks() {
  updateStats();
  const grid      = document.getElementById('task-grid');
  const emptyEl   = document.getElementById('empty-state');
  const filtered  = getFilteredTasks();

  // Remove old cards
  grid.querySelectorAll('.task-card').forEach(c => c.remove());

  if (filtered.length === 0) {
    emptyEl.style.display = 'flex';
    return;
  }
  emptyEl.style.display = 'none';

  // Sort: overdue → pending → done; within groups by scheduled date
  const order = { overdue: 0, pending: 1, done: 2 };
  filtered.sort((a, b) => {
    const sa = getStatus(a), sb = getStatus(b);
    if (sa !== sb) return order[sa] - order[sb];
    if (a.scheduledAt && b.scheduledAt) return new Date(a.scheduledAt) - new Date(b.scheduledAt);
    if (a.scheduledAt)  return -1;
    if (b.scheduledAt)  return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  filtered.forEach(task => grid.appendChild(buildCard(task)));
}

function buildCard(task) {
  const status = getStatus(task);
  const badgeMap = {
    pending: ['badge-pending', '⏳ Pending'],
    overdue: ['badge-overdue', '🔥 Overdue'],
    done:    ['badge-done',    '✓ Done']
  };
  const [badgeCls, badgeTxt] = badgeMap[status];
  const scheduled = task.scheduledAt ? formatDateTime(task.scheduledAt) : null;

  const card = document.createElement('div');
  card.className = `task-card status-${status}`;
  card.dataset.id = task.id;

  card.innerHTML = `
    ${task.imageUrl ? `<img class="task-card-image" src="${escapeHtml(task.imageUrl)}" alt="Task image" loading="lazy" />` : ''}
    <div class="task-card-body">
      <div class="task-card-header">
        <h3 class="task-title">${escapeHtml(task.title)}</h3>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
      </div>
      ${task.description ? `<p class="task-description">${escapeHtml(task.description)}</p>` : ''}
      ${scheduled ? `
        <div class="task-schedule${status === 'overdue' ? ' is-overdue' : ''}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          ${status === 'overdue' ? 'Due: ' : ''}${escapeHtml(scheduled)}
        </div>` : ''}
    </div>
    <div class="task-card-footer">
      ${status !== 'done'
        ? `<button class="btn btn-success btn-sm js-done"   >✓ Done</button>`
        : `<button class="btn btn-secondary btn-sm js-reopen">↩ Reopen</button>`}
      <button class="btn btn-secondary btn-sm js-view"  >View</button>
      <button class="btn btn-secondary btn-sm js-edit"  >Edit</button>
      <button class="btn btn-danger    btn-sm js-delete" >Delete</button>
    </div>`;

  // Attach events safely (no inline handlers)
  card.querySelector('.js-done')   ?.addEventListener('click', () => handleMarkDone(task.id));
  card.querySelector('.js-reopen') ?.addEventListener('click', () => handleReopen(task.id));
  card.querySelector('.js-view')    .addEventListener('click', () => openDetailModal(task.id));
  card.querySelector('.js-edit')    .addEventListener('click', () => openEditModal(task.id));
  card.querySelector('.js-delete')  .addEventListener('click', () => handleDelete(task.id));

  return card;
}

// ── Create / Edit Modal ──────────────────────────────────────────
function openCreateModal() {
  editingTaskId       = null;
  pendingRemoveImage  = false;

  document.getElementById('modal-title').textContent  = 'New Task';
  document.getElementById('submit-btn').textContent   = 'Create Task';
  document.getElementById('task-form').reset();
  setImagePreview(null);
  document.getElementById('task-modal').removeAttribute('hidden');
  document.getElementById('task-title').focus();
}

function openEditModal(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  editingTaskId       = taskId;
  pendingRemoveImage  = false;

  document.getElementById('modal-title').textContent = 'Edit Task';
  document.getElementById('submit-btn').textContent  = 'Save Changes';
  document.getElementById('task-title').value        = task.title;
  document.getElementById('task-description').value  = task.description || '';

  if (task.scheduledAt) {
    // Convert UTC ISO to local datetime-local string (YYYY-MM-DDTHH:MM)
    const d   = new Date(task.scheduledAt);
    const loc = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    document.getElementById('task-scheduled').value = loc;
  } else {
    document.getElementById('task-scheduled').value = '';
  }

  setImagePreview(task.imageUrl || null);
  document.getElementById('task-modal').removeAttribute('hidden');
  document.getElementById('task-title').focus();
}

function closeTaskModal() {
  document.getElementById('task-modal').setAttribute('hidden', '');
  document.getElementById('task-form').reset();
  editingTaskId      = null;
  pendingRemoveImage = false;
}

// ── Detail Modal ─────────────────────────────────────────────────
function openDetailModal(taskId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;

  const status = getStatus(task);
  const badgeMap = {
    pending: ['badge-pending', 'Pending'],
    overdue: ['badge-overdue', 'Overdue'],
    done:    ['badge-done',    'Done']
  };
  const [badgeCls, badgeTxt] = badgeMap[status];

  document.getElementById('detail-title').textContent = task.title;

  document.getElementById('detail-content').innerHTML = `
    ${task.imageUrl ? `<img class="detail-image" src="${escapeHtml(task.imageUrl)}" alt="Task image" />` : ''}
    ${task.description
      ? `<div class="detail-description">${escapeHtml(task.description)}</div>`
      : ''}
    <div class="detail-meta">
      <div class="detail-meta-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <span class="meta-label">Status:</span>
        <span class="badge ${badgeCls}">${badgeTxt}</span>
      </div>
      ${task.scheduledAt ? `
      <div class="detail-meta-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span class="meta-label">Scheduled:</span>
        <span class="meta-value">${escapeHtml(formatDateTime(task.scheduledAt))}</span>
      </div>` : ''}
      <div class="detail-meta-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="4" width="18" height="18" rx="2"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span class="meta-label">Created:</span>
        <span class="meta-value">${escapeHtml(formatDateTime(task.createdAt))}</span>
      </div>
      ${task.completedAt ? `
      <div class="detail-meta-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span class="meta-label">Completed:</span>
        <span class="meta-value">${escapeHtml(formatDateTime(task.completedAt))}</span>
      </div>` : ''}
    </div>`;

  // Footer buttons
  const footer = document.getElementById('detail-footer');
  footer.innerHTML = '';
  if (status !== 'done') {
    const doneBtn = document.createElement('button');
    doneBtn.className = 'btn btn-success';
    doneBtn.textContent = '✓ Mark Done';
    doneBtn.addEventListener('click', () => { handleMarkDone(task.id); closeDetailModal(); });
    footer.appendChild(doneBtn);
  }
  const editBtn = document.createElement('button');
  editBtn.className = 'btn btn-secondary';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => { closeDetailModal(); openEditModal(task.id); });
  footer.appendChild(editBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-ghost';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeDetailModal);
  footer.appendChild(closeBtn);

  document.getElementById('detail-modal').removeAttribute('hidden');
}

function closeDetailModal() {
  document.getElementById('detail-modal').setAttribute('hidden', '');
}

// ── CRUD Handlers ────────────────────────────────────────────────
async function handleFormSubmit(e) {
  e.preventDefault();
  const submitBtn = document.getElementById('submit-btn');
  submitBtn.disabled = true;
  const origText = submitBtn.textContent;
  submitBtn.textContent = 'Saving…';

  try {
    const fd = new FormData(e.target);
    fd.delete('taskId');   // not used server-side

    // Convert datetime-local to proper ISO with timezone
    const rawDate = fd.get('scheduledAt');
    if (rawDate) {
      fd.set('scheduledAt', new Date(rawDate).toISOString());
    } else {
      fd.set('scheduledAt', '');
    }

    // Flag image removal
    fd.set('removeImage', pendingRemoveImage ? 'true' : 'false');

    // If we're removing the image, clear any newly selected file
    if (pendingRemoveImage) fd.delete('image');

    let task;
    if (editingTaskId) {
      task = await API.updateTask(editingTaskId, fd);
      tasks = tasks.map(t => t.id === editingTaskId ? task : t);
      showToast('Task updated', 'success');
    } else {
      task = await API.createTask(fd);
      tasks.unshift(task);
      showToast('Task created', 'success');
    }
    closeTaskModal();
    renderTasks();
  } catch (err) {
    showToast(err.message || 'An error occurred', 'error');
  } finally {
    submitBtn.disabled   = false;
    submitBtn.textContent = origText;
  }
}

async function handleMarkDone(taskId) {
  try {
    const task = await API.markDone(taskId);
    tasks = tasks.map(t => t.id === taskId ? task : t);
    notifiedIds.delete(taskId); // allow future re-notification if reopened
    renderTasks();
    showToast('Task marked as done!', 'success');
  } catch (err) {
    showToast(err.message || 'Failed to update task', 'error');
  }
}

async function handleReopen(taskId) {
  try {
    const task = await API.reopenTask(taskId);
    tasks = tasks.map(t => t.id === taskId ? task : t);
    renderTasks();
    showToast('Task reopened', 'info');
  } catch (err) {
    showToast(err.message || 'Failed to reopen task', 'error');
  }
}

async function handleDelete(taskId) {
  if (!confirm('Delete this task permanently?')) return;
  try {
    await API.deleteTask(taskId);
    tasks = tasks.filter(t => t.id !== taskId);
    renderTasks();
    showToast('Task deleted', 'info');
  } catch (err) {
    showToast(err.message || 'Failed to delete task', 'error');
  }
}

// ── Image Upload UI ──────────────────────────────────────────────
function setImagePreview(url) {
  const preview     = document.getElementById('image-preview');
  const placeholder = document.getElementById('upload-placeholder');
  const img         = document.getElementById('preview-img');
  const fileInput   = document.getElementById('task-image');

  if (url) {
    img.src = url;
    preview.hidden     = false;
    placeholder.hidden = true;
  } else {
    preview.hidden     = true;
    placeholder.hidden = false;
    img.src            = '';
    fileInput.value    = '';
  }
}

function setupImageUpload() {
  const area       = document.getElementById('image-upload-area');
  const fileInput  = document.getElementById('task-image');
  const removeBtn  = document.getElementById('remove-image-btn');

  // Click on area → open file picker (skip if clicking remove button)
  area.addEventListener('click', e => {
    if (!e.target.closest('.remove-image-btn')) fileInput.click();
  });
  area.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });

  // Drag and drop
  area.addEventListener('dragover', e => { e.preventDefault(); area.style.borderColor = 'var(--primary)'; });
  area.addEventListener('dragleave', ()  => { area.style.borderColor = ''; });
  area.addEventListener('drop', e => {
    e.preventDefault();
    area.style.borderColor = '';
    const file = e.dataTransfer.files[0];
    if (file?.type.startsWith('image/')) applyFile(file);
  });

  // File input change
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) applyFile(file);
  });

  // Remove image
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    pendingRemoveImage = true;
    setImagePreview(null);
  });

  function applyFile(file) {
    if (file.size > 5 * 1024 * 1024) { showToast('Image must be under 5 MB', 'warning'); return; }
    pendingRemoveImage = false;
    const reader = new FileReader();
    reader.onload = ev => setImagePreview(ev.target.result);
    reader.readAsDataURL(file);

    // Sync to the hidden file input via DataTransfer
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
  }
}

// ── PWA Install Prompt ───────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;

  const btn = document.createElement('button');
  btn.id        = 'install-btn';
  btn.className = 'btn btn-secondary';
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>Install App`;
  btn.addEventListener('click', async () => {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') showToast('App installed successfully!', 'success');
    deferredInstallPrompt = null;
    btn.remove();
  });
  document.querySelector('.header-actions').prepend(btn);
});

// ── Service Worker ───────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(reg => console.log('Service Worker registered, scope:', reg.scope))
      .catch(err => console.warn('Service Worker registration failed:', err));
  });
}

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  // Wire up static buttons
  document.getElementById('add-task-btn').addEventListener('click',    openCreateModal);
  document.getElementById('empty-add-btn').addEventListener('click',   openCreateModal);
  document.getElementById('modal-close-btn').addEventListener('click', closeTaskModal);
  document.getElementById('cancel-btn').addEventListener('click',      closeTaskModal);
  document.getElementById('detail-close-btn').addEventListener('click',closeDetailModal);
  document.getElementById('notif-btn').addEventListener('click',       requestNotificationPermission);
  document.getElementById('task-form').addEventListener('submit',      handleFormSubmit);

  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderTasks();
    });
  });

  // Set initial active tab to match currentFilter
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  const defaultTab = document.querySelector(`.filter-tab[data-filter="${currentFilter}"]`);
  if (defaultTab) defaultTab.classList.add('active');

  // Close modals on overlay click
  document.getElementById('task-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTaskModal();
  });
  document.getElementById('detail-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDetailModal();
  });

  // Keyboard: Escape closes modals
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeTaskModal(); closeDetailModal(); }
  });

  setupImageUpload();

  // Load tasks
  try {
    tasks = await API.getTasks();
  } catch {
    showToast('Could not connect to server. Is it running?', 'error');
  }
  renderTasks();

  // Notification button visibility
  if (Notification.permission === 'granted') {
    document.getElementById('notif-btn').hidden = true;
    startNotificationPoller();
  }

  // Handle ?action=new shortcut (from PWA shortcuts)
  if (new URLSearchParams(location.search).get('action') === 'new') {
    history.replaceState({}, '', '/');
    openCreateModal();
  }

  // Refresh data every 30 s to keep overdue badges accurate
  setInterval(async () => {
    try { tasks = await API.getTasks(); renderTasks(); } catch {}
  }, 30_000);
}

document.addEventListener('DOMContentLoaded', init);
