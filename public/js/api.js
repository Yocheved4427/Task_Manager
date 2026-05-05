/* global fetch */
'use strict';

/**
 * Thin wrapper around the REST API.
 * All methods throw on HTTP errors so callers can catch them.
 */
const API = (() => {
  const BASE = '/api';

  async function handleResponse(res) {
    if (!res.ok) {
      let msg = `Server error ${res.status}`;
      try { const body = await res.json(); msg = body.detail || body.error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  return {
    getTasks() {
      return fetch(`${BASE}/tasks`).then(handleResponse);
    },

    createTask(formData) {
      return fetch(`${BASE}/tasks`, { method: 'POST', body: formData })
        .then(handleResponse);
    },

    updateTask(id, formData) {
      return fetch(`${BASE}/tasks/${encodeURIComponent(id)}`, { method: 'PUT', body: formData })
        .then(handleResponse);
    },

    markDone(id) {
      return fetch(`${BASE}/tasks/${encodeURIComponent(id)}/done`, { method: 'PATCH' })
        .then(handleResponse);
    },

    reopenTask(id) {
      return fetch(`${BASE}/tasks/${encodeURIComponent(id)}/reopen`, { method: 'PATCH' })
        .then(handleResponse);
    },

    deleteTask(id) {
      return fetch(`${BASE}/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then(handleResponse);
    }
  };
})();
