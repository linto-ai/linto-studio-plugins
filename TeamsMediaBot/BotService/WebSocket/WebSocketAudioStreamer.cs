using System;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace BotService.WebSocket
{
    /// <summary>
    /// WebSocket client for streaming PCM 16-bit audio data
    /// </summary>
    public class WebSocketAudioStreamer : IWebSocketAudioStreamer
    {
        private readonly ILogger<WebSocketAudioStreamer> _logger;
        private ClientWebSocket _webSocket;
        private string _websocketUrl;
        private readonly SemaphoreSlim _connectionSemaphore;
        private bool _disposed;

        public WebSocketAudioStreamer(ILogger<WebSocketAudioStreamer> logger)
        {
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _connectionSemaphore = new SemaphoreSlim(1, 1);
        }

        public bool IsConnected => _webSocket?.State == WebSocketState.Open;

        public void Configure(string websocketUrl)
        {
            if (string.IsNullOrWhiteSpace(websocketUrl))
                throw new ArgumentException("WebSocket URL cannot be null or empty", nameof(websocketUrl));

            _websocketUrl = websocketUrl;
            _logger.LogInformation("WebSocket configured for URL: {WebSocketUrl}", websocketUrl);
        }

        public async Task ConnectAsync(CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(_websocketUrl))
                throw new InvalidOperationException("WebSocket URL not configured. Call Configure() first.");

            await _connectionSemaphore.WaitAsync(cancellationToken);

            try
            {
                if (IsConnected)
                {
                    _logger.LogDebug("WebSocket already connected");
                    return;
                }

                // Dispose existing connection if any
                _webSocket?.Dispose();

                _webSocket = new ClientWebSocket();
                
                // Add subprotocol for audio streaming if needed
                _webSocket.Options.AddSubProtocol("audio-pcm");
                
                // Set keep alive interval
                _webSocket.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);

                _logger.LogInformation("Connecting to WebSocket: {WebSocketUrl}", _websocketUrl);
                
                var uri = new Uri(_websocketUrl);
                await _webSocket.ConnectAsync(uri, cancellationToken);

                _logger.LogInformation("✅ WebSocket connected successfully to {WebSocketUrl}", _websocketUrl);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to connect to WebSocket: {WebSocketUrl}", _websocketUrl);
                _webSocket?.Dispose();
                _webSocket = null;
                throw;
            }
            finally
            {
                _connectionSemaphore.Release();
            }
        }

        public async Task SendAudioAsync(ReadOnlyMemory<byte> audioData, CancellationToken cancellationToken)
        {
            if (!IsConnected)
            {
                _logger.LogWarning("WebSocket not connected, attempting to reconnect...");
                await ConnectAsync(cancellationToken);
                
                if (!IsConnected)
                {
                    _logger.LogError("Cannot send audio data - WebSocket connection failed");
                    return;
                }
            }

            try
            {
                // Send PCM 16-bit audio data as binary message
                // Convert ReadOnlyMemory<byte> to ArraySegment<byte> for .NET Framework
                var buffer = audioData.ToArray();
                var arraySegment = new ArraySegment<byte>(buffer);
                
                await _webSocket.SendAsync(
                    arraySegment, 
                    WebSocketMessageType.Binary, 
                    endOfMessage: true, 
                    cancellationToken);

                _logger.LogDebug("Sent {ByteCount} bytes of PCM audio data via WebSocket", audioData.Length);
            }
            catch (WebSocketException ex) when (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
            {
                _logger.LogWarning("WebSocket connection closed prematurely, will attempt reconnect on next send");
                await DisconnectAsync(CancellationToken.None);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send audio data via WebSocket");
                throw;
            }
        }

        public async Task DisconnectAsync(CancellationToken cancellationToken)
        {
            await _connectionSemaphore.WaitAsync(cancellationToken);

            try
            {
                if (_webSocket?.State == WebSocketState.Open)
                {
                    _logger.LogInformation("Closing WebSocket connection...");
                    
                    await _webSocket.CloseAsync(
                        WebSocketCloseStatus.NormalClosure, 
                        "Disconnecting audio stream", 
                        cancellationToken);
                    
                    _logger.LogInformation("WebSocket connection closed");
                }

                _webSocket?.Dispose();
                _webSocket = null;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during WebSocket disconnect");
                _webSocket?.Dispose();
                _webSocket = null;
            }
            finally
            {
                _connectionSemaphore.Release();
            }
        }

        public void Dispose()
        {
            if (_disposed)
                return;

            try
            {
                DisconnectAsync(CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during disposal");
            }

            _connectionSemaphore?.Dispose();
            _disposed = true;
        }
    }
}