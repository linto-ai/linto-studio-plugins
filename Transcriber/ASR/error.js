const ASR_ERROR = {
  NO_ERROR: 'No error',
  AUTHENTICATION_FAILURE: 'Automatic transcription has been stopped due to an authentication error',
  BAD_REQUEST_PARAMETERS: 'Automatic transcription has been stopped due to an invalid parameter',
  TOO_MANY_REQUESTS: 'Automatic transcription has been stopped due to too many request',
  CONNECTION_FAILURE: 'Automatic transcription has been stopped due to a connection error',
  SERVICE_TIMEOUT: 'Automatic transcription has been stopped due to a timeout error',
  SERVICE_ERROR: 'Automatic transcription has been stopped due to service error',
  RUNTIME_ERROR: 'Automatic transcription has been stopped due to an unexpected runtime error',
  FORBIDDEN: 'Automatic transcription has been stopped due to a forbidden error',
  STARTUP_TIMEOUT: 'Automatic transcription has been stopped because the ASR service did not respond. Check your API key and endpoint.',
  STARTUP_ERROR: 'Automatic transcription has been stopped due to an error during ASR startup'
}

module.exports = ASR_ERROR
