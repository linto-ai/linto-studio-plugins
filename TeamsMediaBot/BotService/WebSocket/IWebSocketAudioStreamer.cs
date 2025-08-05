using System;
using System.Threading;
using System.Threading.Tasks;

namespace BotService.WebSocket
{
    /// <summary>
    /// Interface for WebSocket audio streaming
    /// </summary>
    public interface IWebSocketAudioStreamer : IDisposable
    {
        /// <summary>
        /// Configure the WebSocket connection
        /// </summary>
        /// <param name="websocketUrl">WebSocket URL to connect to</param>
        void Configure(string websocketUrl);

        /// <summary>
        /// Send PCM 16-bit audio data via WebSocket
        /// </summary>
        /// <param name="audioData">PCM 16-bit audio data</param>
        /// <param name="cancellationToken">Cancellation token</param>
        Task SendAudioAsync(ReadOnlyMemory<byte> audioData, CancellationToken cancellationToken);

        /// <summary>
        /// Connect to the WebSocket endpoint
        /// </summary>
        /// <param name="cancellationToken">Cancellation token</param>
        Task ConnectAsync(CancellationToken cancellationToken);

        /// <summary>
        /// Disconnect from the WebSocket endpoint
        /// </summary>
        /// <param name="cancellationToken">Cancellation token</param>
        Task DisconnectAsync(CancellationToken cancellationToken);

        /// <summary>
        /// Check if WebSocket is connected
        /// </summary>
        bool IsConnected { get; }
    }
}