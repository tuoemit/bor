'use strict';

(function () {
  const form = document.getElementById('loginForm');
  const input = document.getElementById('password');
  const error = document.getElementById('loginError');
  const hint = document.getElementById('loginHint');
  const btn = document.getElementById('submitBtn');

  fetch('/api/auth/me')
    .then((r) => r.json())
    .then((me) => {
      if (me.authenticated) {
        location.replace('/');
        return;
      }
      if (me.configured === false) {
        error.textContent = 'PANEL_PASSWORD is not set on this deployment.';
        hint.textContent = 'Set the PANEL_PASSWORD environment variable in your Render/Railway dashboard, then redeploy.';
        btn.disabled = true;
      }
    })
    .catch(() => {});

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Unlocking…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'panel' },
        body: JSON.stringify({ password: input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        location.replace('/');
        return;
      }
      error.textContent = data.message || `Login failed (${res.status}).`;
      if (res.status === 429 && data.retryAfterSeconds) {
        let left = data.retryAfterSeconds;
        const tick = setInterval(() => {
          left -= 1;
          btn.textContent = left > 0 ? `Locked (${left}s)` : 'Unlock panel';
          if (left <= 0) {
            clearInterval(tick);
            btn.disabled = false;
          }
        }, 1000);
      } else {
        btn.disabled = false;
      }
    } catch (e) {
      error.textContent = `Network error: ${e.message}`;
      btn.disabled = false;
    }
    btn.textContent = 'Unlock panel';
    input.select();
  });
})();
