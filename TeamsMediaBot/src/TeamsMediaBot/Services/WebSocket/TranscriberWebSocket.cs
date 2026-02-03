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
        private readonly SemaphoreSlim _sendLock = new(1, 1);

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
                _logger.LogDebug("[WebSocket] Connecting to {Host}:{Port}", uri.Host, uri.Port);

                _webSocket = new ClientWebSocket();
                await _webSocket.ConnectAsync(uri, cancellationToken);

                // Send init message
                var initMessage = JsonSerializer.Serialize(new
                {
                    type = "init",
                    encoding = "pcm",
                    sampleRate = SampleRate,
                    diarizationMode = "native",
                    participants = Array.Empty<object>()
                });

                var initBytes = Encoding.UTF8.GetBytes(initMessage);
                await _webSocket.SendAsync(new ArraySegment<byte>(initBytes), WebSocketMessageType.Text, true, cancellationToken);

                // Wait for ACK with timeout
                var ackReceived = await WaitForAckAsync(cancellationToken);
                if (!ackReceived)
                {
                    _logger.LogError("[WebSocket] ACK timeout from Transcriber");
                    await CloseAsync();
                    return false;
                }

                _isReady = true;
                _isConnecting = false;

                await FlushBufferAsync(cancellationToken);

                _receiveCts = new CancellationTokenSource();
                _receiveTask = ReceiveLoopAsync(_receiveCts.Token);

                _logger.LogInformation("[WebSocket] Connected to Transcriber");
                return true;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[WebSocket] Connection failed");
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
                    _logger.LogDebug("[WebSocket] Received: {Message}", message);

                    try
                    {
                        using var doc = JsonDocument.Parse(message);
                        if (doc.RootElement.TryGetProperty("type", out var typeElement) &&
                            typeElement.GetString() == "ack")
                        {
                            return true;
                        }
                    }
                    catch (JsonException)
                    {
                        // Ignore parse errors
                    }
                }
            }
            catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested)
            {
                _logger.LogDebug("[WebSocket] ACK timeout");
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "[WebSocket] Error waiting for ACK");
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
                _logger.LogDebug("[WebSocket] Flushed {Count} buffered audio packets", flushedCount);
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

            await _sendLock.WaitAsync(cancellationToken);
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
            finally
            {
                _sendLock.Release();
            }
        }

        /// <inheritdoc/>
        public async Task SendJsonMessageAsync(string jsonMessage, CancellationToken cancellationToken = default)
        {
            if (_disposed || _webSocket?.State != WebSocketState.Open)
            {
                return;
            }

            var bytes = Encoding.UTF8.GetBytes(jsonMessage);
            await _sendLock.WaitAsync(cancellationToken);
            try
            {
                await _webSocket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    cancellationToken);
            }
            catch (WebSocketException ex)
            {
                _logger.LogError(ex, "[TeamsMediaBot] WebSocket send JSON error");
                OnError?.Invoke(this, ex);
            }
            finally
            {
                _sendLock.Release();
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
                        _logger.LogWarning("[WebSocket] Server closed: {Status}", result.CloseStatus);
                        _isReady = false;
                        OnClosed?.Invoke(this, EventArgs.Empty);
                        break;
                    }

                    if (result.MessageType == WebSocketMessageType.Text)
                    {
                        var message = Encoding.UTF8.GetString(buffer, 0, result.Count);
                        _logger.LogDebug("[WebSocket] Received: {Message}", message);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Normal shutdown
            }
            catch (WebSocketException ex) when (ex.WebSocketErrorCode == WebSocketError.ConnectionClosedPrematurely)
            {
                _logger.LogWarning("[WebSocket] Connection closed prematurely");
                _isReady = false;
                OnClosed?.Invoke(this, EventArgs.Empty);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[WebSocket] Receive loop error");
                _isReady = false;
                OnError?.Invoke(this, ex);
            }
        }

        /// <inheritdoc/>
        public async Task CloseAsync()
        {
            _isReady = false;
            _isConnecting = false;
            _receiveCts?.Cancel();

            if (_webSocket?.State == WebSocketState.Open)
            {
                try
                {
                    await _webSocket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Closing", CancellationToken.None);
                }
                catch
                {
                    // Ignore close errors
                }
            }

            if (_receiveTask != null)
            {
                try { await _receiveTask; }
                catch { /* Ignore */ }
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
            _sendLock.Dispose();
        }
    }
}
