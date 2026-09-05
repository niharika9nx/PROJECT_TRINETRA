// Trinetra — popup.js (Phase 1 shell)
// Minimal UI: User Goal input + Start button + status area.
// Clicking Start logs goal to console per Phase 1 DoD. No agent logic yet.

document.addEventListener('DOMContentLoaded', () => {
  const goalInput = document.getElementById('goalInput');
  const startBtn = document.getElementById('startBtn');
  const statusText = document.getElementById('statusText');

  if (!goalInput || !startBtn || !statusText) {
    console.error('[Trinetra] popup.js: required elements not found');
    return;
  }

  // Restore last goal from storage for convenience
  try {
    chrome.storage.local.get(['lastGoal'], (result) => {
      if (result && result.lastGoal) {
        goalInput.value = result.lastGoal;
      }
    });
  } catch (e) {
    // storage may be unavailable in some contexts — ignore
  }

  startBtn.addEventListener('click', () => {
    const goal = goalInput.value.trim();

    console.log('[Trinetra] User Goal:', goal);

    if (!goal) {
      statusText.textContent = 'Please enter a goal before clicking Start.';
      statusText.style.color = '#fbbf24';
      return;
    }

    // Persist for next popup open
    try {
      chrome.storage.local.set({ lastGoal: goal });
    } catch (e) {}

    statusText.textContent = `Goal logged: "${goal}"\nCheck console (Ctrl+Shift+J) for log output.`;
    statusText.style.color = '#86efac';

    // Also log structured entry for future phases to pick up
    console.log('[Trinetra] Start clicked', {
      goal,
      timestamp: new Date().toISOString(),
      phase: 'Phase 1 shell — no agent loop yet'
    });
  });

  goalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      startBtn.click();
    }
  });
});
