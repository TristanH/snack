// Runs on app.slack.com. The Slack web client keeps its API token (xoxc-) in
// localStorage; hand it to Snack so it can call the API with your session.
// The matching `d` cookie never leaves the browser: Chrome attaches it to
// Snack's requests because the extension has *.slack.com host permissions.

function capture() {
  try {
    const cfg = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
    const teams = Object.values(cfg.teams || {}).filter((t) => t.token?.startsWith('xoxc-'));
    if (!teams.length) return false;
    const team = teams.find((t) => t.id === cfg.lastActiveTeamId) || teams[0];
    chrome.storage.local.set({
      slackTeam: { id: team.id, name: team.name, url: team.url, token: team.token, capturedAt: Date.now() },
    });
    return true;
  } catch {
    return false;
  }
}

// Slack may still be booting (or signing in) when this runs, so keep trying.
if (!capture()) {
  let tries = 0;
  const timer = setInterval(() => {
    if (capture() || ++tries > 60) clearInterval(timer);
  }, 1000);
}
