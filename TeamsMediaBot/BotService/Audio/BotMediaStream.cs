using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Skype.Bots.Media;
using BotService.WebSocket;

namespace BotService.Audio
{
    /// <summary>
    /// Bot media stream for handling real-time audio from Teams meetings
    /// Based on Microsoft Graph Communications SDK samples
    /// </summary>
    public class BotMediaStream : IDisposable
    {
        private readonly ILogger<BotMediaStream> _logger;
        private readonly IWebSocketAudioStreamer _audioStreamer;
        private readonly List<IVideoSocket> _videoSockets;
        private readonly List<IAudioSocket> _audioSockets;
        private bool _disposed = false;

        public BotMediaStream(ILogger<BotMediaStream> logger, IWebSocketAudioStreamer audioStreamer)
        {
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
            _audioStreamer = audioStreamer ?? throw new ArgumentNullException(nameof(audioStreamer));
            _videoSockets = new List<IVideoSocket>();
            _audioSockets = new List<IAudioSocket>();
        }

        /// <summary>
        /// Initialize the media stream with audio and video sockets
        /// </summary>
        public void Initialize(ICollection<object> mediaSockets)
        {
            try
            {
                _logger.LogInformation("Initializing BotMediaStream with {SocketCount} media sockets", mediaSockets?.Count ?? 0);

                if (mediaSockets == null) return;

                foreach (var mediaSocket in mediaSockets)
                {
                    if (mediaSocket is IAudioSocket audioSocket)
                    {
                        _logger.LogInformation("Setting up audio socket - ID: {SocketId}", audioSocket.SocketId);
                        
                        // Subscribe to audio events
                        audioSocket.AudioMediaReceived += OnAudioMediaReceived;
                        audioSocket.AudioSendStatusChanged += OnAudioSendStatusChanged;
                        
                        _audioSockets.Add(audioSocket);
                        _logger.LogInformation("✅ Audio socket configured successfully");
                    }
                    else if (mediaSocket is IVideoSocket videoSocket)
                    {
                        _logger.LogInformation("Video socket detected - ID: {SocketId} (monitoring only)", videoSocket.SocketId);
                        
                        // Subscribe to video events for participant tracking
                        videoSocket.VideoMediaReceived += OnVideoMediaReceived;
                        videoSocket.VideoKeyFrameNeeded += OnVideoKeyFrameNeeded;
                        
                        _videoSockets.Add(videoSocket);
                        _logger.LogInformation("✅ Video socket configured for participant tracking");
                    }
                }

                _logger.LogInformation("BotMediaStream initialized - Audio: {AudioCount}, Video: {VideoCount}", 
                    _audioSockets.Count, _videoSockets.Count);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to initialize BotMediaStream");
                throw;
            }
        }

        /// <summary>
        /// Handle received audio media from Teams meeting
        /// </summary>
        private async void OnAudioMediaReceived(object sender, AudioMediaReceivedEventArgs e)
        {
            try
            {
                var audioSocket = sender as IAudioSocket;
                _logger.LogDebug("Received audio buffer - Socket: {SocketId}, Length: {Length}, Timestamp: {Timestamp}", 
                    audioSocket?.SocketId, e.Buffer.Length, e.Buffer.Timestamp);

                // Convert audio data to PCM 16-bit format if needed
                var pcmData = ConvertToPcm16(e.Buffer);
                
                // Forward to WebSocket/SRT streamer
                if (_audioStreamer != null && pcmData.Length > 0)
                {
                    await _audioStreamer.SendAudioAsync(pcmData);
                    _logger.LogTrace("Audio data forwarded to WebSocket/SRT streamer - {ByteCount} bytes", pcmData.Length);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to process received audio media");
            }
        }

        /// <summary>
        /// Handle audio send status changes
        /// </summary>
        private void OnAudioSendStatusChanged(object sender, AudioSendStatusChangedEventArgs e)
        {
            try
            {
                var audioSocket = sender as IAudioSocket;
                _logger.LogInformation("Audio send status changed - Socket: {SocketId}, Status: {Status}", 
                    audioSocket?.SocketId, e.MediaSendStatus);

                switch (e.MediaSendStatus)
                {
                    case MediaSendStatus.Active:
                        _logger.LogInformation("🎙️ Audio streaming is now ACTIVE");
                        break;
                    case MediaSendStatus.Inactive:
                        _logger.LogInformation("🔇 Audio streaming is now INACTIVE");
                        break;
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to handle audio send status change");
            }
        }

        /// <summary>
        /// Handle received video media (for participant tracking)
        /// </summary>
        private void OnVideoMediaReceived(object sender, VideoMediaReceivedEventArgs e)
        {
            try
            {
                // We only log video events for participant tracking, don't process video data
                var videoSocket = sender as IVideoSocket;
                _logger.LogDebug("Video frame received - Socket: {SocketId}, Width: {Width}, Height: {Height}", 
                    videoSocket?.SocketId, e.Buffer.VideoFormat.Width, e.Buffer.VideoFormat.Height);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to handle video media received event");
            }
        }

        /// <summary>
        /// Handle video key frame requests
        /// </summary>
        private void OnVideoKeyFrameNeeded(object sender, VideoKeyFrameNeededEventArgs e)
        {
            try
            {
                var videoSocket = sender as IVideoSocket;
                _logger.LogDebug("Video key frame needed - Socket: {SocketId}", videoSocket?.SocketId);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to handle video key frame needed event");
            }
        }

        /// <summary>
        /// Convert audio buffer to PCM 16-bit format
        /// </summary>
        private ReadOnlyMemory<byte> ConvertToPcm16(AudioMediaBuffer buffer)
        {
            try
            {
                // Teams audio is typically already in PCM 16kHz 16-bit mono format
                // If conversion is needed, implement here
                
                var audioData = new byte[buffer.Length];
                buffer.Data.CopyTo(audioData, 0);
                
                return audioData;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to convert audio to PCM16 format");
                return ReadOnlyMemory<byte>.Empty;
            }
        }

        /// <summary>
        /// Get current audio socket statistics
        /// </summary>
        public AudioSocketStatistics GetAudioStatistics()
        {
            try
            {
                var stats = new AudioSocketStatistics();
                
                foreach (var audioSocket in _audioSockets)
                {
                    // Aggregate statistics from all audio sockets
                    stats.ActiveSockets++;
                    
                    // You can add more detailed statistics here if available from the SDK
                }
                
                return stats;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to get audio statistics");
                return new AudioSocketStatistics();
            }
        }

        public void Dispose()
        {
            if (_disposed) return;

            try
            {
                _logger.LogInformation("Disposing BotMediaStream resources");

                // Clean up audio sockets
                foreach (var audioSocket in _audioSockets)
                {
                    try
                    {
                        audioSocket.AudioMediaReceived -= OnAudioMediaReceived;
                        audioSocket.AudioSendStatusChanged -= OnAudioSendStatusChanged;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to cleanup audio socket");
                    }
                }

                // Clean up video sockets
                foreach (var videoSocket in _videoSockets)
                {
                    try
                    {
                        videoSocket.VideoMediaReceived -= OnVideoMediaReceived;
                        videoSocket.VideoKeyFrameNeeded -= OnVideoKeyFrameNeeded;
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to cleanup video socket");
                    }
                }

                _audioSockets.Clear();
                _videoSockets.Clear();

                _disposed = true;
                _logger.LogInformation("BotMediaStream disposed successfully");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during BotMediaStream disposal");
            }
        }
    }

    /// <summary>
    /// Audio socket statistics
    /// </summary>
    public class AudioSocketStatistics
    {
        public int ActiveSockets { get; set; }
        public long TotalPacketsReceived { get; set; }
        public long TotalBytesReceived { get; set; }
        public DateTime LastActivity { get; set; } = DateTime.UtcNow;
    }
}