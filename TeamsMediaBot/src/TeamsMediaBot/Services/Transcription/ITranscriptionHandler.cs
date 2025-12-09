using TeamsMediaBot.Models.Mqtt;
using TeamsMediaBot.Services.Orchestration;

namespace TeamsMediaBot.Services.Transcription
{
    /// <summary>
    /// Interface for handling transcription messages and displaying captions.
    /// </summary>
    public interface ITranscriptionHandler
    {
        /// <summary>
        /// Handles a transcription message for a managed bot.
        /// </summary>
        /// <param name="bot">The managed bot.</param>
        /// <param name="transcription">The transcription message.</param>
        /// <param name="isFinal">Whether this is a final transcription.</param>
        void HandleTranscription(ManagedBot bot, TranscriptionMessage transcription, bool isFinal);
    }
}
