// Dev bridge, injected only into http://localhost:4477. Relays the Snack UI's
// requests to background.js so the dev page behaves exactly like the
// extension page (see platform.js).

window.addEventListener('message', async (e) => {
  if (e.source !== window || e.origin !== location.origin || e.data?.snack !== 'req') return;
  const { id, op, args } = e.data;
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ op, args });
  } catch (err) {
    // Typically "Extension context invalidated" after a reload: refresh the page.
    reply = { error: err.message };
  }
  window.postMessage({ snack: 'res', id, ...reply }, location.origin); // Empty if nothing answered.
});
