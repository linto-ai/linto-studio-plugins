/**
 * Teams App Configuration Page Script
 * Handles the configuration/settings page for adding the app to a meeting.
 */
(async function () {
  const statusEl = document.getElementById('config-status')

  try {
    // Initialize Teams SDK
    if (window.teamsSdk && window.teamsSdk.isInTeams()) {
      await window.teamsSdk.initialize()

      // Register save handler FIRST (before setValidityState)
      window.teamsSdk.registerSaveHandler(() => {
        // Configuration is always valid for this simple app
        return true
      })

      // THEN notify Teams that the configuration is valid
      window.teamsSdk.notifySuccess()

      statusEl.textContent = 'Click "Save" to add Live Transcription to your meeting'
    } else {
      statusEl.textContent = 'Running in preview mode (outside of Teams)'
    }
  } catch (err) {
    console.error('[TeamsAppConfigure] Error:', err)
    statusEl.textContent = 'Error: ' + err.message
    statusEl.style.color = 'var(--error)'
  }
})()
