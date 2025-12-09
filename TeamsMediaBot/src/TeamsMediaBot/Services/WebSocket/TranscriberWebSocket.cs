using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace TeamsMediaBot.Services.WebSocket
{
    /// <summary>
    /// WebSocket client for streaming audio to the Transcriber service.
    /// </summary>
    public class TranscriberWebSocket : ITranscriberWebSocket
    {
        private readonly ILogger<TranscriberWebSocket> _logger;
        private ClientWebSocket? _webSocket;
        private readonly ConcurrentQueue<byte[]> _audioBuffer;
        private readonly int _maxBufferSeconds;
        private readonly int _bytesPerSecond;
        private bool _isReady;
        private bool _isConnecting;
        private bool _disposed;
        private CancellationTokenSource? _receiveCts;
        private Task? _receiveTask;

        /// <inheritdoc/>
        public bool IsReady => _isReady && _webSocket?.State == WebSocketState.Open;

        /// <inheritdoc/>
        public bool IsConnecting => _isConnecting;

        /// <inheritdoc/>
        public event EventHandler? OnClosed;

        /// <inheritdoc/>
        public event EventHandler<Exception>? OnError;

        // Audio format constants (PCM S16LE, 16kHz, mono)
        private const int SampleRate = 16000;
        private const int BytesPerSample = 2;

        public TranscriberWebSocket(ILogger<TranscriberWebSocket> logger)
        {
            _logger = logger;
            _audioBuffer = new ConcurrentQueue<byte[]>();
            _maxBufferSeconds = 10; // MAX_AUDIO_BUFFER from config
            _bytesPerSecond = SampleRate * BytesPerSample; // 32000 bytes/sec
        }

        /// <inheritdoc/>
        public async Task<bool> ConnectAsync(string websocketUrl, CancellationToken cancellationToken = default)
        {
            if (_disposed)
            {
                throw new ObjectDisposedException(nameof(TranscriberWebSocket));
            }

            _isConnecting = true;
            _isReady = false;

            try
            {
                _logger.LogInformation("[TeamsMediaBot] Connecting to Transcriber WebSocket: {Url}", websocketUrl);

                _webSocket = new ClientWebSocket();
                await _webSocket.ConnectAsync(new Uri(websocketUrl), cancellationToken);

                _logger.LogInformation("[TeamsMediaBot] WebSocket connected, sending init message");

                // Send init message
                var initMessage = JsonSerializer.Serialize(new
                {
                    type = "init",
                    encoding = "pcm",
                    sampleRate = SampleRate
                });

                var initBytes = Encoding.UTF8.GetBytes(initMessage);
                await _webSocket.SendAsync(new ArraySegment<byte>(initBytes), WebSocketMessageType.Text, true, cancellationToken);

                // Wait for ACK with timeout
                var ackReceived = await WaitForAckAsync(cancellationToken);
                if (!ackReceived)
                {
                    _logger.LogError("[TeamsMediaBot] Did not receive ACK from Transcriber");
                    await CloseAsync();
                    return false;
                }

                _isReady = true;
                _isConnecting = false;

                // Flush buffered audio
                await FlushBufferAsync(cancellationToken);

                // Start receive loop for potential messages
                _receiveCts = new CancellationTokenSource();
                _receiveTask = ReceiveLoopAsync(_receiveCts.Token);

                _logger.LogInformation("[TeamsMediaBot] WebSocket ready, audio streaming enabled");
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Failed to connect to Transcriber WebSocket");
                _isConnecting = false;
                OnError?.Invoke(this, ex);
                return false;
            }
        }

        private async Task<bool> WaitForAckAsync(CancellationToken cancellationToken)
        {
            if (_webSocket == null) return false;

            var buffer = new byte[1024];
            var timeout = TimeSpan.FromSeconds(10);
            using var timeoutCts = new CancellationTokenSource(timeout);
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

            try
            {
                var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), linkedCts.Token);

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    _logger.LogDebug("[TeamsMediaBot] Received message: {Message}", message);

                    try
                    {
                        using var doc = JsonDocument.Parse(message);
                        if (doc.RootElement.TryGetProperty("type", out var typeElement) &&
                            typeElement.GetString() == "ack")
                        {
                            _logger.LogInformation("[TeamsMediaBot] Received ACK from Transcriber");
                            return true;
                        }
                    }
                    catch (JsonException)
                    {
                        // Not JSON, ignore
                    }
                }
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
            {
                _logger.LogWarning("[TeamsMediaBot] Timeout waiting for ACK");
            }

            return false;
        }

        private async Task FlushBufferAsync(CancellationToken cancellationToken)
        {
            var flushedCount = 0;
            while (_audioBuffer.TryDequeue(out var audioData))
            {
                await SendAudioInternalAsync(audioData, cancellationToken);
                flushedCount++;
            }

            if (flushedCount > 0)
            {
                _logger.LogInformation("[TeamsMediaBot] Flushed {Count} buffered audio packets", flushedCount);
            }
        }

        /// <inheritdoc/>
        public async Task SendAudioAsync(byte[] audioData, CancellationToken cancellationToken = default)
        {
            if (_disposed)
            {
                return;
            }

            if (_isReady && _webSocket?.State == WebSocketState.Open)
            {
                // Send immediately
                await SendAudioInternalAsync(audioData, cancellationToken);
            }
            else if (_isConnecting)
            {
                // Buffer while connecting
                BufferAudio(audioData);
            }
            // Otherwise drop the audio (not connected)
        }

        private void BufferAudio(byte[] audioData)
        {
            // Calculate max buffer size in bytes
            var maxBufferBytes = _maxBufferSeconds * _bytesPerSecond;

            // Calculate current buffer size
            var currentSize = _audioBuffer.Sum(b => b.Length);

            // If adding this would exceed max, drop oldest
            while (currentSize + audioData.Length > maxBufferBytes && _audioBuffer.TryDequeue(out var dropped))
            {
                currentSize -= dropped.Length;
            }

            _audioBuffer.Enqueue(audioData);
        }

        private async Task SendAudioInternalAsync(byte[] audioData, CancellationToken cancellationToken)
        {
            if (_webSocket?.State != WebSocketState.Open)
            {
                return;
            }

            try
            {
                await _webSocket.SendAsync(
                    new ArraySegment<byte>(audioData),
                    WebSocketMessageType.Binary,
                    true,
                    cancellationToken);
            }
            catch (WebSocketException ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] WebSocket send error");
                OnError?.Invoke(this, ex);
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
        {
            var buffer = new byte[4096];

            try
            {
                while (!cancellationToken.IsCancellationRequested && _webSocket?.State == WebSocketState.Open)
                {
                    var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _logger.LogInformation("[TeamsMediaBot] WebSocket closed by server");
                        _isReady = false;
                        OnClosed?.Invoke(this, EventArgs.Empty);
                        break;
                    }

                    // Log any text messages (errors, etc.)
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        _logger.LogDebug("[TeamsMediaBot] Received text message: {Message}", message);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Normal cancellation
            }
            catch (WebSocketException ex) when (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
            {
                _logger.LogWarning("[TeamsMediaBot] WebSocket connection closed prematurely");
                _isReady = false;
                OnClosed?.Invoke(this, EventArgs.Empty);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] Error in WebSocket receive loop");
                _isReady = false;
                OnError?.Invoke(this, ex);
            }
        }

        /// <inheritdoc/>
        public async Task CloseAsync()
        {
            _isReady = false;
            _isConnecting = false;

            // Cancel receive loop
            _receiveCts?.Cancel();

            if (_webSocket?.State == WebSocketState.Open)
            {
                try
                {
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[TeamsMediaBot] Error closing WebSocket");
                }
            }

            // Wait for receive task to complete
            if (_receiveTask != null)
            {
                try
                {
                    await _receiveTask;
                }
                catch
                {
                    // Ignore
                }
            }

            _webSocket?.Dispose();
            _webSocket = null;
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;

            _receiveCts?.Cancel();
            _receiveCts?.Dispose();
            _webSocket?.Dispose();
        }
    }
}
