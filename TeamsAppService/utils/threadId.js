/**
 * Thread ID utilities for Teams App Service.
 * Handles normalization of Teams thread IDs between different formats.
 */

/**
 * Normalize a Teams thread ID to the standard Graph API format.
 *
 * The Teams SDK sends threadId encoded in Base64 with a special format:
 * `MCMxOTptZWV0aW5nX1pqQTJZV1kyT0RndFpqa3hNQzAwWXpjMUxXSTROV0V0T0dZek1UazFNV0prT0dJM0B0aHJlYWQudjIjMA==`
 *
 * Once decoded, it becomes:
 * `0#19:meeting_ZjA2YWY2ODgtZjkxMC00Yzc1LWI4NWEtOGYzMTk1MWJkOGI3@thread.v2#0`
 *
 * But TeamsMediaBot publishes via MQTT the raw threadId (Graph API format):
 * `19:meeting_ZjA2YWY2ODgtZjkxMC00Yzc1LWI4NWEtOGYzMTk1MWJkOGI3@thread.v2`
 *
 * @param {string} threadId - The thread ID to normalize (Base64 encoded or raw)
 * @returns {string} The normalized thread ID in format: `19:meeting_xxx@thread.v2`
 */
function normalizeThreadId(threadId) {
  if (!threadId) {
    return threadId
  }

  // If the threadId contains ':' or '@', it's already in the raw format
  if (threadId.includes(':') || threadId.includes('@')) {
    return threadId
  }

  try {
    // Decode from Base64
    const decoded = Buffer.from(threadId, 'base64').toString('utf-8')

    // Extract the thread ID between the '#' characters
    // Format: 0#19:meeting_xxx@thread.v2#0
    const parts = decoded.split('#')

    if (parts.length >= 2 && parts[1]) {
      return parts[1]
    }

    // If split didn't work, return the decoded value
    return decoded
  } catch (err) {
    // If decoding fails, return the original value
    return threadId
  }
}

module.exports = {
  normalizeThreadId
}
