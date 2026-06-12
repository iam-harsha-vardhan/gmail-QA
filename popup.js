const ids = [
  'msgid',
  'logo',
  'pixel',
  'unsub',
  'listunsub'
];

// Load saved state into checkboxes
chrome.storage.local.get(ids, data => {

  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.checked = !!data[id];
  });
});

// Save on change
ids.forEach(id => {

  const el = document.getElementById(id);

  if (el) {
    el.addEventListener('change', e => {
      chrome.storage.local.set({ [id]: e.target.checked });
    });
  }
});
