(async function () {
  'use strict';

  let panel = null;
  let currentMsg = null;
  let cachedData = null;
  let gmailIK = null;
  let renderToken = 0;
  let cachedSettings = null;
  let extensionContextInvalidated = false;

  const SUBID_PREFIXES = '(?:GRM|GMFP|GTC|GRTC|GBM|GBTC|AJTC|GM|GIFST|AGM|AGMB)';

  const PREFIX_SUBID_RE = new RegExp(
    `(?:^|[^A-Za-z0-9])(${SUBID_PREFIXES}[A-Za-z0-9.-]*-NL-[A-Za-z0-9.-]*[A-Za-z0-9])(?=$|[^A-Za-z0-9])`,
    'i'
  );

  const NL_FALLBACK_RE =
    /(?:^|[^A-Za-z0-9])([A-Z0-9][A-Z0-9.-]*-NL-[A-Z0-9.-]*[A-Z0-9])(?=$|[^A-Za-z0-9])/i;

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  script.onload = () => script.remove();
  document.documentElement.appendChild(script);

  window.addEventListener('message', event => {
    if (event.source !== window) return;

    if (event.data && event.data.type === 'GAUTH_IK') {
      gmailIK = event.data.ik;
      console.log('[Links IK]', gmailIK);
      scheduleRenderMessageData(120);
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

  function getAccountIndex() {
    const m = location.pathname.match(/\/u\/(\d+)/);
    return m ? m[1] : '0';
  }

  function isExtensionContextError(error) {
    return /Extension context invalidated/i.test(error?.message || String(error || ''));
  }

  async function getLinkSettings() {
    if (extensionContextInvalidated) return cachedSettings;

    try {
      cachedSettings = await chrome.storage.local.get([
        'msgid',
        'logo',
        'pixel',
        'unsub',
        'listunsub'
      ]);
      return cachedSettings;
    } catch (e) {
      if (isExtensionContextError(e)) {
        extensionContextInvalidated = true;
        return cachedSettings;
      }

      throw e;
    }
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.error('[Links Copy]', e);
    }
  }

  function normalizeBody(raw) {
    return raw
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#x22;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&amp;/g, '&')
      .replace(/=\r?\n/g, '')
      .replace(/=3D/gi, '=');
  }

  function getCurrentMessageId() {
    if (!isMailOpen()) return null;

    const container = document.querySelector('[data-message-id]');
    if (!container) return null;

    const permId = container.dataset.messageId;
    if (!permId) return null;

    const clean = permId.replace('#', '');
    const match = clean.match(/msg-f:([0-9]+)/);

    return match ? match[1] : null;
  }

  function normalizeBrokenUrl(url) {
    return (url || '')
      .replace(/=\r?\n/g, '')
      .replace(/=\s+(?=[A-Za-z0-9_./:%?&=#-])/g, '')
      .replace(/=3D/gi, '=')
      .replace(/&amp;/g, '&')
      .trim();
  }

  function decodeMimeWords(value) {
    return (value || '').replace(
      /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
      (_, charset, encoding, text) => {
        try {
          let bytes;

          if (encoding.toUpperCase() === 'B') {
            bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
          } else {
            const qp = text
              .replace(/_/g, ' ')
              .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
                String.fromCharCode(parseInt(hex, 16))
              );

            bytes = Uint8Array.from(qp, c => c.charCodeAt(0));
          }

          return new TextDecoder(charset || 'utf-8').decode(bytes);
        } catch {
          return text;
        }
      }
    );
  }

  function findPrefixedSubIdInText(text) {
    return text ? text.match(PREFIX_SUBID_RE)?.[1] || null : null;
  }

  function findNlFallbackSubIdInText(text) {
    return text ? text.match(NL_FALLBACK_RE)?.[1] || null : null;
  }

  function findSubIdInText(text) {
    return findPrefixedSubIdInText(text) || findNlFallbackSubIdInText(text);
  }

  function tryBase64Variants(token) {
    const clean = (token || '').replace(/[^A-Za-z0-9+/_=-]/g, '');
    if (!clean || clean.length < 8) return [];

    const variants = new Set([
      clean,
      clean.replace(/-/g, '+').replace(/_/g, '/')
    ]);

    const decoded = [];

    for (const value of variants) {
      for (let i = 0; i < 4; i++) {
        try {
          const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
          const binary = atob(padded);
          const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);

          if (text && /[A-Za-z0-9]/.test(text)) {
            decoded.push(text);
          }
        } catch {
          break;
        }
      }
    }

    return decoded;
  }

  function extractSubIdFromText(text) {
    const normalized = decodeMimeWords(text || '');
    const direct = findPrefixedSubIdInText(normalized);

    if (direct) return direct;

    const tokens = normalized
      .replace(/[<>]/g, ' ')
      .split(/[._\s@:;,|"'\[\](){}]+/)
      .filter(Boolean);

    for (const token of tokens) {
      const tokenMatch = findPrefixedSubIdInText(token);
      if (tokenMatch) return tokenMatch;

      for (const decoded of tryBase64Variants(token)) {
        const decodedMatch = findPrefixedSubIdInText(decoded);
        if (decodedMatch) return decodedMatch;
      }
    }

    const fallback = findNlFallbackSubIdInText(normalized);

    if (fallback) return fallback;

    for (const token of tokens) {
      const tokenMatch = findNlFallbackSubIdInText(token);
      if (tokenMatch) return tokenMatch;

      for (const decoded of tryBase64Variants(token)) {
        const decodedMatch = findNlFallbackSubIdInText(decoded);
        if (decodedMatch) return decodedMatch;
      }
    }

    return null;
  }

  function extractSubId(gmailMsgId, raw) {
    return (
      extractSubIdFromText(gmailMsgId) ||
      extractSubIdFromText(raw) ||
      null
    );
  }

  function extractListUnsubscribe(raw) {
    const header = (raw || '').match(/^list-unsubscribe:\s*([\s\S]*?)(?=\r?\n[^\s]|$)/im)?.[1];
    if (!header) return null;

    const unfolded = header
      .replace(/\r?\n[ \t]+/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/=\r?\n/g, '')
      .replace(/=3D/gi, '=');

    const urls = [...unfolded.matchAll(/<?(https?:\/\/[^\s<>,]+)>?/gi)]
      .map(m => normalizeBrokenUrl(m[1]));

    return urls.find(url => /^https:\/\//i.test(url)) || urls[0] || null;
  }

  function isOnePixelTag(tag) {
    const px = '(?:0|1)(?:\\.0+)?\\s*(?:px)?';
    const width = new RegExp(`\\bwidth\\s*=\\s*["']${px}["']`, 'i').test(tag);
    const height = new RegExp(`\\bheight\\s*=\\s*["']${px}["']`, 'i').test(tag);
    return width && height;
  }

  function getImgSrc(tag) {
    const m = tag.match(/\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    return m ? normalizeBrokenUrl(m[1] || m[2]) : null;
  }

  function getImgTags(html) {
    return [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  }

  async function fetchMessageData(forceRefresh, expectedMsg) {
    try {
      if (!gmailIK) return null;

      const msg = getCurrentMessageId();
      if (!msg || msg !== expectedMsg) return null;

      if (!forceRefresh && currentMsg === msg && cachedData) {
        return cachedData;
      }

      currentMsg = msg;

      const url =
        `https://mail.google.com/mail/u/${getAccountIndex()}` +
        `/?ik=${gmailIK}&view=om&permmsgid=msg-f:${msg}`;

      console.log('[Links URL]', url);

      const response = await fetch(url, { credentials: 'include' });
      const raw = await response.text();

      if (getCurrentMessageId() !== expectedMsg) return null;

      const norm = normalizeBody(raw);
      const rawUnfolded = raw.replace(/=\r?\n/g, '');

      const gmailMsgId =
        raw.match(/Message-ID:\s*&lt;([^&]+)&gt;/i)?.[1] ||
        raw.match(/Message-ID:\s*<([^>]+)>/i)?.[1] ||
        null;

      const originalMsgId =
        raw.match(/X-Google-Original-Message-ID:\s*&lt;([^&]+)&gt;/i)?.[1] ||
        raw.match(/X-Google-Original-Message-ID:\s*<([^>]+)>/i)?.[1] ||
        null;

      const isBroken = !!gmailMsgId?.includes('SMTPIN_ADDED_BROKEN');
      const subId = extractSubId(gmailMsgId, raw);

      const listUnsub = extractListUnsubscribe(raw);


      const oneClick = /List-Unsubscribe=One-Click/i.test(raw);

      let pixel = null;
      const imgTags = getImgTags(norm);

      for (const tag of imgTags) {
        if (isOnePixelTag(tag)) {
          pixel = getImgSrc(tag);
          if (pixel) break;
        }
      }

      const imageUrlPattern =
        /https?:\/\/[^\s"'<>&\r\n]+\.(?:jpg|jpeg|gif)(?:[^\s"'<>&\r\n]*)?/gi;

      const allImageUrls = [
        ...new Set(
          [...rawUnfolded.matchAll(imageUrlPattern)]
            .map(m => normalizeBrokenUrl(m[0]))
        )
      ];

      const logo = allImageUrls.find(u => u !== pixel) || null;

      const allHrefs = [...norm.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)]
        .map(m => m[1]);

      const nonPixelHrefs = allHrefs.filter(h => h !== pixel);
      const unsub = nonPixelHrefs[nonPixelHrefs.length - 1] || null;

      console.log('MSG-ID:', gmailMsgId);
      console.log('SUB-ID:', subId);
      console.log('BROKEN:', isBroken);
      console.log('LOGO:', logo);
      console.log('PIXEL:', pixel);
      console.log('UNSUB:', unsub);
      console.log('LIST:', listUnsub);
      console.log('1-CLICK:', oneClick);

      cachedData = {
        gmailMsgId,
        originalMsgId,
        subId,
        isBroken,
        logo,
        pixel,
        unsub,
        listUnsub,
        oneClick
      };

      return cachedData;

    } catch (e) {
      console.error('[Links Fetch]', e);
      return null;
    }
  }

  async function checkUrlStatus(url, type) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        credentials: 'omit'
      });

      const finalUrl = response.url || '';

      if (type === 'unsub') {
        return finalUrl.includes('success.php') ? 'green' : 'red';
      }

      if (type === 'listunsub') {
        if (finalUrl.toLowerCase().includes('success')) return 'green';

        try {
          const body = await response.text();
          return body.toLowerCase().includes('success') ? 'green' : 'red';
        } catch {
          return 'red';
        }
      }

      return 'neutral';

    } catch {
      return 'neutral';
    }
  }

  function createActionItem(label, url) {
    const wrap = document.createElement('div');
    wrap.className = 'links-action';

    const dot = document.createElement('div');
    dot.className = 'links-dot links-dot-neutral';
    wrap.appendChild(dot);

    const open = document.createElement('button');
    open.className = 'links-open';
    open.textContent = label;
    open.title = url;
    open.addEventListener('click', () => {
      if (url) window.open(url, '_blank');
    });
    wrap.appendChild(open);

    const copy = document.createElement('button');
    copy.className = 'links-copy';
    copy.textContent = '📋';
    copy.title = 'Copy URL';
    copy.addEventListener('click', event => {
      event.stopPropagation();
      if (url) copyText(url);
    });
    wrap.appendChild(copy);

    return { wrap, dot };
  }

  function createMsgItem(label, value, cls) {
    const item = document.createElement('div');
    item.className = cls ? `gauth-item ${cls}` : 'gauth-item';

    const lbl = document.createElement('span');
    lbl.className = 'links-label';
    lbl.textContent = `${label}:`;

    const val = document.createElement('span');
    val.className = 'links-value';
    val.textContent = value;
    val.title = value;

    const copy = document.createElement('button');
    copy.className = 'links-copy links-subid-copy';
    copy.textContent = '📋';
    copy.title = 'Copy';
    copy.addEventListener('click', event => {
      event.stopPropagation();
      copyText(value);
    });

    item.appendChild(lbl);
    item.appendChild(val);
    item.appendChild(copy);

    return item;
  }

  function createOpenAllItem(urls, token, expectedMsg) {
    const button = document.createElement('button');
    button.className = 'links-open-all';
    button.title = 'Open all visible links';
    button.innerHTML = '<span class="links-open-all-icon">&#8599;</span>';

    button.addEventListener('click', () => {
      if (token !== renderToken || getCurrentMessageId() !== expectedMsg) return;

      urls.forEach(url => {
        if (!url) return;

        const opened = window.open(url, '_blank');
        if (opened) opened.blur();
      });

      window.focus();
      setTimeout(() => window.focus(), 40);
      setTimeout(() => window.focus(), 140);
    });

    return button;
  }

  function getPanel() {
    panel = document.querySelector('#gauth-panel');
    return panel;
  }

  function setBrokenBackground(isBroken) {
    if (!getPanel()) return;

    if (isBroken) {
      panel.classList.remove('gauth-safe', 'gauth-warning');
      panel.classList.add('gauth-danger');
    }
  }

  async function renderMessageData(forceRefresh) {
    const token = ++renderToken;
    const expectedMsg = getCurrentMessageId();

    try {
      document.querySelector('#links-panel')?.remove();

      if (!expectedMsg) return;
      if (!getPanel()) return;

      const s = await getLinkSettings();
      if (!s) return;

      const data = await fetchMessageData(forceRefresh, expectedMsg);

      if (token !== renderToken || getCurrentMessageId() !== expectedMsg) return;
      if (!data) return;

      setBrokenBackground(data.isBroken);

      if (!s.msgid && !s.logo && !s.pixel && !s.unsub && !s.listunsub) return;

      const lp = document.createElement('div');
      lp.id = 'links-panel';

      if (s.msgid) {
        if (data.isBroken) {
          lp.appendChild(
            createMsgItem('SUB-ID', 'SMTPIN_ADDED_BROKEN', 'gauth-fail')
          );

          if (data.originalMsgId) {
            const originalSubId = extractSubIdFromText(data.originalMsgId) || data.originalMsgId;
            lp.appendChild(createMsgItem('ORIGINAL', originalSubId, ''));
          }
        } else {
          lp.appendChild(
            createMsgItem('SUB-ID', data.subId || 'N/A', '')
          );
        }
      }

      const grid = document.createElement('div');
      grid.className = 'links-grid';

      const visibleUrls = [];
      const visibleActions = [];

      if (s.logo && data.logo) {
        const { wrap } = createActionItem('LOGO', data.logo);
        wrap.classList.add('links-logo-cell');
        grid.appendChild(wrap);
        visibleUrls.push(data.logo);
        visibleActions.push(wrap);
      }

      if (s.pixel && data.pixel) {
        const { wrap } = createActionItem('PIXEL', data.pixel);
        wrap.classList.add('links-pixel-cell');
        grid.appendChild(wrap);
        visibleUrls.push(data.pixel);
        visibleActions.push(wrap);
      }

      if (s.unsub && data.unsub) {
        const { wrap, dot } = createActionItem('UNSUB', data.unsub);
        wrap.classList.add('links-unsub-cell');
        dot.className = 'links-dot links-dot-loading';
        grid.appendChild(wrap);
        visibleUrls.push(data.unsub);
        visibleActions.push(wrap);

        checkUrlStatus(data.unsub, 'unsub').then(status => {
          if (token === renderToken && getCurrentMessageId() === expectedMsg) {
            dot.className = `links-dot links-dot-${status}`;
          }
        });
      }

      if (s.listunsub && data.listUnsub) {
        const { wrap, dot } = createActionItem('LIST-UNSUB', data.listUnsub);
        wrap.classList.add('links-list-cell');
        dot.className = 'links-dot links-dot-loading';
        grid.appendChild(wrap);
        visibleUrls.push(data.listUnsub);
        visibleActions.push(wrap);

        checkUrlStatus(data.listUnsub, 'listunsub').then(status => {
          if (token === renderToken && getCurrentMessageId() === expectedMsg) {
            dot.className = `links-dot links-dot-${status}`;
          }
        });
      }

      const positionClasses = [
        'links-pos-left-top',
        'links-pos-right-top',
        'links-pos-left-bottom',
        'links-pos-right-bottom'
      ];

      visibleActions.forEach((wrap, index) => {
        wrap.classList.add(positionClasses[index]);
      });

      if (visibleActions.length === 1) {
        grid.classList.add('links-grid-single');
      } else if (visibleActions.length > 1) {
        grid.classList.add(`links-grid-count-${visibleActions.length}`);
        grid.appendChild(createOpenAllItem(visibleUrls, token, expectedMsg));
      }

      if (grid.children.length > 0) {
        lp.appendChild(grid);
      }

      if (token === renderToken && getCurrentMessageId() === expectedMsg) {
        panel.appendChild(lp);
      }

    } catch (e) {
      if (isExtensionContextError(e)) {
        extensionContextInvalidated = true;
        return;
      }

      console.error('[Links Render]', e);
    }
  }

  function scheduleRenderMessageData(delay) {
    renderToken++;

    setTimeout(() => {
      renderMessageData();
    }, delay);
  }

  function scheduleSearchOpenRetries() {
    [160, 650, 1400, 2400].forEach(delay => {
      scheduleRenderMessageData(delay);
    });
  }

  let mutationRenderTimer = null;

  function scheduleDomReadyRender() {
    if (!isMailOpen() || document.querySelector('#links-panel')) return;
    if (mutationRenderTimer) return;

    mutationRenderTimer = setTimeout(() => {
      mutationRenderTimer = null;

      if (isMailOpen() && !document.querySelector('#links-panel')) {
        scheduleRenderMessageData(60);
      }
    }, 220);
  }

  let lastUrl = location.href;

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      currentMsg = null;
      cachedData = null;
      renderToken++;
      document.querySelector('#links-panel')?.remove();

      if (!isMailOpen()) return;

      scheduleSearchOpenRetries();
    }
  }, 250);

  setTimeout(renderMessageData, 500);
  setTimeout(renderMessageData, 1100);
  setTimeout(scheduleDomReadyRender, 1800);

  try {
    new MutationObserver(scheduleDomReadyRender).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  } catch (e) {
    console.error('[Links Observer]', e);
  }

  try {
    chrome.storage.onChanged.addListener(() => {
      console.log('[Links] Settings Changed');
      currentMsg = null;
      cachedData = null;
      cachedSettings = null;
      scheduleRenderMessageData(80);
    });
  } catch (e) {
    if (!isExtensionContextError(e)) {
      console.error('[Links Settings Listener]', e);
    }
  }

})();