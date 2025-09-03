using System;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using Microsoft.Skype.Bots.Media;
using BotService.WebSocket;

namespace BotService.Audio
{
    /// <summary>
    /// Handles audio socket events for capturing meeting audio
    /// </summary>
    public class AudioSocketListener
    {
        private readonly ILogger<AudioSocketListener> _logger;
        private readonly IWebSocketAudioStreamer _audioStreamer;
        private IAudioSocket _audioSocket;
        
        public AudioSocketListener(ILogger<AudioSocketListener> logger, IWebSocketAudioStreamer audioStreamer)
        {
            _logger = logger;
            _audioStreamer = audioStreamer;
        }
        
        /// <summary>
        /// Subscribe to audio socket events
        /// </summary>
        public void Subscribe(IAudioSocket audioSocket)
        {
            _audioSocket = audioSocket;
            
            // Subscribe to audio events
            _audioSocket.AudioMediaReceived += OnAudioMediaReceived;
            _audioSocket.AudioSendStatusChanged += OnAudioSendStatusChanged;
            
            _logger.LogInformation("✅ Audio socket listener subscribed to events");
        }
        
        /// <summary>
        /// Unsubscribe from audio socket events
        /// </summary>
        public void Unsubscribe()
        {
            if (_audioSocket != null)
            {
                _audioSocket.AudioMediaReceived -= OnAudioMediaReceived;
                _audioSocket.AudioSendStatusChanged -= OnAudioSendStatusChanged;
                _audioSocket = null;
                
                _logger.LogInformation("Audio socket listener unsubscribed");
            }
        }
        
        /// <summary>
        /// Handles incoming audio frames (20ms PCM samples at 50 FPS)
        /// </summary>
        private void OnAudioMediaReceived(object sender, AudioMediaReceivedEventArgs e)
        {
            try
            {
                var audioBuffer = e.Buffer;
                _logger.LogDebug("📡 Audio frame received: {Length} bytes", audioBuffer.Length);
                
                // Convert audio buffer to byte array
                var audioData = new byte[audioBuffer.Length];
                System.Runtime.InteropServices.Marshal.Copy(audioBuffer.Data, audioData, 0, (int)audioBuffer.Length);
                
                // Send audio to WebSocket streamer asynchronously (don't block the event)
                _ = Task.Run(async () =>
                {
                    try
                    {
                        await _audioStreamer.SendAudioAsync(audioData, default);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogError(ex, "Failed to stream audio frame via WebSocket");
                    }
                });
            }
            finally
            {
                // CRITICAL: Always dispose the buffer after processing
                e.Buffer?.Dispose();
            }
        }
        
        /// <summary>
        /// Handles audio send status changes
        /// </summary>
        private void OnAudioSendStatusChanged(object sender, AudioSendStatusChangedEventArgs e)
        {
            _logger.LogInformation("🎙️ Audio send status changed: {Status}", e.MediaSendStatus);
            
            switch (e.MediaSendStatus)
            {
                case MediaSendStatus.Active:
                    _logger.LogInformation("✅ Audio streaming is now active - ready to receive frames");
                    break;
                case MediaSendStatus.Inactive:
                    _logger.LogInformation("⏸️ Audio streaming is now inactive");
                    break;
            }
        }
    }
}