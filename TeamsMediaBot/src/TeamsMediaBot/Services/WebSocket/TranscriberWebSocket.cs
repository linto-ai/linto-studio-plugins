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
                _logger.LogError("[WebSocket] ConnectAsync called on disposed instance");
                throw new ObjectDisposedException(nameof(TranscriberWebSocket));
            }

            _isConnecting = true;
            _isReady = false;

            try
            {
                var uri = new Uri(websocketUrl);
                _logger.LogInformation("[WebSocket] === CONNECTION ATTEMPT ===");
                _logger.LogInformation("[WebSocket] URL: {Url}", websocketUrl);
                _logger.LogInformation("[WebSocket] Host: {Host}, Port: {Port}, Scheme: {Scheme}", uri.Host, uri.Port, uri.Scheme);

                _webSocket = new ClientWebSocket();

                _logger.LogInformation("[WebSocket] Initiating connection...");
                var connectStart = DateTime.UtcNow;

                try
                {
                    await _webSocket.ConnectAsync(uri, cancellationToken);
                }
                catch (WebSocketException wsEx)
                {
                    _logger.LogError("[WebSocket] CONNECTION FAILED - WebSocketException");
                    _logger.LogError("[WebSocket] Error Code: {ErrorCode}", wsEx.WebSocketErrorCode);
                    _logger.LogError("[WebSocket] Message: {Message}", wsEx.Message);
                    _logger.LogError("[WebSocket] Inner Exception: {Inner}", wsEx.InnerException?.Message ?? "none");
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogError("[WebSocket] CONNECTION FAILED - {ExceptionType}", ex.GetType().Name);
                    _logger.LogError("[WebSocket] Message: {Message}", ex.Message);
                    throw;
                }

                var connectDuration = DateTime.UtcNow - connectStart;
                _logger.LogInformation("[WebSocket] Connected in {Duration}ms, State: {State}",
                    connectDuration.TotalMilliseconds, _webSocket.State);
                _logger.LogInformation("[WebSocket] Sending init message...");

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
                _logger.LogInformation("[WebSocket] Waiting for ACK from Transcriber (timeout: 10s)...");
                var ackReceived = await WaitForAckAsync(cancellationToken);
                if (!ackReceived)
                {
                    _logger.LogError("[WebSocket] === ACK NOT RECEIVED ===");
                    _logger.LogError("[WebSocket] Transcriber did not acknowledge the connection within timeout");
                    _logger.LogError("[WebSocket] Current WebSocket State: {State}", _webSocket?.State);
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

                _logger.LogInformation("[WebSocket] === CONNECTION SUCCESS ===");
                _logger.LogInformation("[WebSocket] WebSocket ready, audio streaming enabled");
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError("[WebSocket] === CONNECTION FAILED ===");
                _logger.LogError(ex, "[WebSocket] Exception during connection: {Message}", ex.Message);
                _isConnecting = false;
                OnError?.Invoke(this, ex);
                return false;
            }
        }

        private async Task<bool> WaitForAckAsync(CancellationToken cancellationToken)
        {
            if (_webSocket == null)
            {
                _logger.LogError("[WebSocket] WaitForAckAsync: WebSocket is null");
                return false;
            }

            var buffer = new byte[1024];
            var timeout = TimeSpan.FromSeconds(10);
            using var timeoutCts = new CancellationTokenSource(timeout);
            using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeoutCts.Token);

            try
            {
                var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), linkedCts.Token);

                _logger.LogInformation("[WebSocket] Received message type: {MessageType}, Count: {Count}",
                    result.MessageType, result.Count);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    _logger.LogError("[WebSocket] Server closed connection while waiting for ACK");
                    _logger.LogError("[WebSocket] Close Status: {Status}, Description: {Desc}",
                        result.CloseStatus, result.CloseStatusDescription);
                    return false;
                }

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                    _logger.LogInformation("[WebSocket] Received text message: {Message}", message);

                    try
                    {
                        using var doc = JsonDocument.Parse(message);
                        if (doc.RootElement.TryGetProperty("type", out var typeElement) &&
                            typeElement.GetString() == "ack")
                        {
                            _logger.LogInformation("[WebSocket] ACK received successfully");
                            return true;
                        }
                        else
                        {
                            _logger.LogWarning("[WebSocket] Received non-ACK message type: {Type}",
                                typeElement.GetString() ?? "unknown");
                        }
                    }
                    catch (JsonException jsonEx)
                    {
                        _logger.LogError("[WebSocket] Failed to parse response as JSON: {Error}", jsonEx.Message);
                    }
                }
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
            {
                _logger.LogError("[WebSocket] TIMEOUT - No response from Transcriber within 10 seconds");
            }
            catch (WebSocketException wsEx)
            {
                _logger.LogError("[WebSocket] WebSocket error while waiting for ACK: {Code} - {Message}",
                    wsEx.WebSocketErrorCode, wsEx.Message);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[WebSocket] Unexpected error while waiting for ACK");
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
            _logger.LogInformation("[WebSocket] Receive loop started");

            try
            {
                while (!cancellationToken.IsCancellationRequested && _webSocket?.State == WebSocketState.Open)
                {
                    var result = await _webSocket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        _logger.LogWarning("[WebSocket] === SERVER CLOSED CONNECTION ===");
                        _logger.LogWarning("[WebSocket] Close Status: {Status}", result.CloseStatus);
                        _logger.LogWarning("[WebSocket] Close Description: {Desc}", result.CloseStatusDescription ?? "none");
                        _isReady = false;
                        OnClosed?.Invoke(this, EventArgs.Empty);
                        break;
                    }

                    // Log any text messages (errors, etc.)
                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        _logger.LogInformation("[WebSocket] Received text message: {Message}", message);
                    }
                }

                _logger.LogInformation("[WebSocket] Receive loop ended. Cancelled: {Cancelled}, State: {State}",
                    cancellationToken.IsCancellationRequested, _webSocket?.State);
            }
            catch (OperationCanceledException)
            {
                _logger.LogInformation("[WebSocket] Receive loop cancelled (normal shutdown)");
            }
            catch (WebSocketException ex) when (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
            {
                _logger.LogError("[WebSocket] === CONNECTION CLOSED PREMATURELY ===");
                _logger.LogError("[WebSocket] The Transcriber closed the connection unexpectedly");
                _isReady = false;
                OnClosed?.Invoke(this, EventArgs.Empty);
            }
            catch (Exception ex)
            {
                _logger.LogError("[WebSocket] === RECEIVE LOOP ERROR ===");
                _logger.LogError(ex, "[WebSocket] Error: {Message}", ex.Message);
                _isReady = false;
                OnError?.Invoke(this, ex);
            }
        }

        /// <inheritdoc/>
        public async Task CloseAsync()
        {
            _logger.LogInformation("[WebSocket] CloseAsync called. Current state: {State}", _webSocket?.State);

            _isReady = false;
            _isConnecting = false;

            // Cancel receive loop
            _receiveCts?.Cancel();

            if (_webSocket?.State == WebSocketState.Open)
            {
                try
                {
                    _logger.LogInformation("[WebSocket] Sending close handshake...");
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                    _logger.LogInformation("[WebSocket] Close handshake completed");
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[WebSocket] Error during close handshake: {Message}", ex.Message);
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
            _logger.LogInformation("[WebSocket] WebSocket disposed");
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
