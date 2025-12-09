namespace TeamsMediaBot.Services.WebSocket
{
    /// <summary>
    /// Interface for WebSocket connection to the Transcriber service.
    /// </summary>
    public interface ITranscriberWebSocket : IDisposable
    {
        /// <summary>
        /// Gets whether the WebSocket is connected and ready to send audio.
        /// </summary>
        bool IsReady { get; }

        /// <summary>
        /// Gets whether the WebSocket is currently connecting.
        /// </summary>
        bool IsConnecting { get; }

        /// <summary>
        /// Event raised when the WebSocket connection is closed.
        /// </summary>
        event EventHandler? OnClosed;

        /// <summary>
        /// Event raised when an error occurs.
        /// </summary>
        event EventHandler<Exception>? OnError;

        /// <summary>
        /// Connects to the Transcriber WebSocket and performs initialization handshake.
        /// </summary>
        /// <param name="websocketUrl">The WebSocket URL to connect to.</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        /// <returns>True if connection and handshake were successful.</returns>
        Task<bool> ConnectAsync(string websocketUrl, CancellationToken cancellationToken = default);

        /// <summary>
        /// Sends audio data to the Transcriber.
        /// </summary>
        /// <param name="audioData">The audio data (PCM S16LE, 16kHz, mono).</param>
        /// <param name="cancellationToken">Cancellation token.</param>
        Task SendAudioAsync(byte[] audioData, CancellationToken cancellationToken = default);

        /// <summary>
        /// Closes the WebSocket connection.
        /// </summary>
        Task CloseAsync();
    }
}
