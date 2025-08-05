using System;

namespace BotService.WebSocket
{
    /// <summary>
    /// Configuration for WebSocket audio streaming
    /// </summary>
    public class WebSocketConfiguration
    {
        /// <summary>
        /// WebSocket URL endpoint
        /// </summary>
        public string WebSocketUrl { get; }

        /// <summary>
        /// Optional stream identifier
        /// </summary>
        public string StreamId { get; }

        /// <summary>
        /// Audio format specification (default: PCM 16-bit)
        /// </summary>
        public string AudioFormat { get; }

        /// <summary>
        /// Sample rate (default: 16000 Hz)
        /// </summary>
        public int SampleRate { get; }

        /// <summary>
        /// Number of channels (default: 1 for mono)
        /// </summary>
        public int Channels { get; }

        public WebSocketConfiguration(
            string webSocketUrl, 
            string streamId = null,
            string audioFormat = "PCM16",
            int sampleRate = 16000,
            int channels = 1)
        {
            if (string.IsNullOrWhiteSpace(webSocketUrl))
                throw new ArgumentException("WebSocket URL cannot be null or empty", nameof(webSocketUrl));

            // Validate URL format
            if (!Uri.TryCreate(webSocketUrl, UriKind.Absolute, out var uri) || 
                (uri.Scheme != "ws" && uri.Scheme != "wss"))
            {
                throw new ArgumentException("Invalid WebSocket URL format. Must be ws:// or wss://", nameof(webSocketUrl));
            }

            WebSocketUrl = webSocketUrl;
            StreamId = streamId ?? Guid.NewGuid().ToString("N").Substring(0, 8);
            AudioFormat = audioFormat;
            SampleRate = sampleRate;
            Channels = channels;
        }

        public override string ToString()
        {
            return $"WebSocket: {WebSocketUrl}, Stream: {StreamId}, Format: {AudioFormat}, Rate: {SampleRate}Hz, Channels: {Channels}";
        }
    }
}