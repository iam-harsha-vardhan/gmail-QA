(async function () {
  'use strict';

  let panel = null;
  let currentMsg = null;
  let gmailIK = null;
  let renderToken = 0;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  document.documentElement.appendChild(script);

  window.addEventListener('message', event => {
    if (event.source !== window) return;

    if (event.data && event.data.type === 'GAUTH_IK') {
      gmailIK = event.data.ik;
      console.log('[GAuth] IK:', gmailIK);
    }
  });

  function isMailOpen() {
    const hash = location.hash.replace(/^#/, '').split('?')[0];
    const parts = hash.split('/').filter(Boolean);

    if (parts.length < 2) return false;
    if (parts[0] === 'category' && parts.length < 3) return false;
    if ((parts[0] === 'search' || parts[0] === 'label') && parts.length < 3) return false;

    const last = parts[parts.length - 1].toLowerCase();
    const listNames = new Set([
      'inbox', 'primary', 'promotions', 'social', 'updates', 'forums',
      'sent', 'drafts', 'starred', 'snoozed', 'all', 'spam', 'trash',
      'important', 'scheduled'
    ]);

    return last.length > 12 && !listNames.has(last);
  }

  function removePanel() {
    document.querySelector('#gauth-panel')?.remove();
    panel = null;
  }

  function createPanel() {
    const existing = document.querySelector('#gauth-panel');

    if (existing) {
      panel = existing;
      return;
    }

    panel = document.createElement('div');
    panel.id = 'gauth-panel';
    document.body.appendChild(panel);
    makeDraggable(panel);
  }

  function makeDraggable(el) {
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    el.addEventListener('mousedown', e => {
      isDragging = true;
      offsetX = e.clientX - el.offsetLeft;
      offsetY = e.clientY - el.offsetTop;
    });

    document.addEventListener('mousemove', e => {
      if (!isDragging) return;

      el.style.left = `${e.clientX - offsetX}px`;
      el.style.top = `${e.clientY - offsetY}px`;
      el.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  function createItem(label, value) {
    const item = document.createElement('div');

    let cls = 'gauth-none';

    if (value === 'PASS') cls = 'gauth-pass';
    else if (value === 'FAIL') cls = 'gauth-fail';

    item.className = `gauth-item ${cls}`;

    const dot = document.createElement('div');
    dot.className = 'gauth-dot';

    const text = document.createElement('div');
    text.innerHTML = `
      ${label}
      <span class="gauth-value">
        ${value}
      </span>
    `;

    item.appendChild(dot);
    item.appendChild(text);

    return item;
  }

  function getAccountIndex() {
    const match = location.pathname.match(/\/u\/(\d+)/);
    return match ? match[1] : '0';
  }

  function getCurrentMessageId() {
    if (!isMailOpen()) return null;

    const container = document.querySelector('[data-message-id]');
    if (!container) return null;

    const permId = container.dataset.messageId;
    if (!permId) return null;

    const cleanPermId = permId.replace('#', '');
    const match = cleanPermId.match(/msg-f:([0-9]+)/);

    return match ? match[1] : null;
  }

  async function fetchAuth(expectedMsg) {
    try {
      if (!gmailIK) return null;

      const msg = getCurrentMessageId();
      if (!msg || msg !== expectedMsg) return null;

      if (currentMsg === msg) return null;
      currentMsg = msg;

      const url =
        `https://mail.google.com/mail/u/${getAccountIndex()}` +
        `/?ik=${gmailIK}&view=om&permmsgid=msg-f:${msg}`;

      console.log('[GAuth] URL:', url);

      const response = await fetch(url, { credentials: 'include' });
      const raw = await response.text();

      if (getCurrentMessageId() !== expectedMsg) return null;

      const auth = {
        spf: 'NONE',
        dkim: 'NONE',
        dmarc: 'NONE'
      };

      if (/spf=pass/i.test(raw)) auth.spf = 'PASS';
      else if (/spf=(fail|softfail|permerror)/i.test(raw)) auth.spf = 'FAIL';

      if (/dkim=pass/i.test(raw)) auth.dkim = 'PASS';
      else if (/dkim=(fail|permerror)/i.test(raw)) auth.dkim = 'FAIL';

      if (/dmarc=pass/i.test(raw)) auth.dmarc = 'PASS';
      else if (/dmarc=(fail|permerror)/i.test(raw)) auth.dmarc = 'FAIL';

      console.log('[GAuth] AUTH:', auth);

      return auth;

    } catch (e) {
      console.error('[GAuth]', e);
      return null;
    }
  }

  async function renderAuth() {
    const token = ++renderToken;
    const expectedMsg = getCurrentMessageId();

    try {
      if (!expectedMsg) {
        removePanel();
        return;
      }

      createPanel();

      panel.classList.add('gauth-loading');

      const auth = await fetchAuth(expectedMsg);

      if (token !== renderToken || getCurrentMessageId() !== expectedMsg) return;

      panel.classList.remove('gauth-loading');

      if (!auth) return;

      panel.classList.remove(
        'gauth-safe',
        'gauth-danger',
        'gauth-warning'
      );

      const values = [auth.spf, auth.dkim, auth.dmarc];
      const hasFail = values.includes('FAIL');
      const hasNone = values.includes('NONE');

      if (hasFail) panel.classList.add('gauth-danger');
      else if (hasNone) panel.classList.add('gauth-warning');
      else panel.classList.add('gauth-safe');

      document.querySelector('.gauth-auth-row')?.remove();

      const authRow = document.createElement('div');
      authRow.className = 'gauth-auth-row';

      authRow.appendChild(createItem('SPF', auth.spf));
      authRow.appendChild(createItem('DKIM', auth.dkim));
      authRow.appendChild(createItem('DMARC', auth.dmarc));

      panel.prepend(authRow);

    } catch (e) {
      console.error('[GAuth Render]', e);
    }
  }

  let lastUrl = location.href;

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentMsg = null;
      renderToken++;

      if (!isMailOpen()) {
        removePanel();
        return;
      }

      document.querySelector('.gauth-auth-row')?.remove();
      setTimeout(renderAuth, 250);
    }
  }, 800);

  setTimeout(renderAuth, 700);

  chrome.storage.onChanged.addListener(() => {
    console.log('[GAuth] Settings Changed');
    currentMsg = null;
    renderToken++;
    setTimeout(renderAuth, 100);
  });

})();