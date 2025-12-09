using TeamsMediaBot.Models.Mqtt;
using TeamsMediaBot.Services.Orchestration;

namespace TeamsMediaBot.Services.Transcription
{
    /// <summary>
    /// Handles transcription messages and displays captions in Teams meetings.
    /// </summary>
    public class TranscriptionHandler : ITranscriptionHandler
    {
        private readonly ILogger<TranscriptionHandler> _logger;

        public TranscriptionHandler(ILogger<TranscriptionHandler> logger)
        {
            _logger = logger;
        }

        /// <inheritdoc/>
        public void HandleTranscription(ManagedBot bot, TranscriptionMessage transcription, bool isFinal)
        {
            if (string.IsNullOrEmpty(transcription.Text))
            {
                return;
            }

            var type = isFinal ? "final" : "partial";
            _logger.LogDebug("[TeamsMediaBot] [{Type}] {Text}", type, transcription.Text);

            // TODO: Implement caption display in Teams meeting
            // The Teams Media Platform currently doesn't have a direct API for displaying captions.
            // Options to consider:
            // 1. Use the Teams bot framework to send messages/cards to the meeting chat
            // 2. Use the Microsoft Graph API to post captions
            // 3. Overlay captions using video (requires video sending capability)
            //
            // For now, we just log the transcriptions.
            // The transcriptions are also being sent to the Scheduler via MQTT,
            // which can store them and display them in the LinTO Studio UI.

            if (isFinal)
            {
                _logger.LogInformation("[TeamsMediaBot] Transcription for session {SessionId}: {Text}",
                    bot.SessionId, transcription.Text);
            }
        }
    }
}
