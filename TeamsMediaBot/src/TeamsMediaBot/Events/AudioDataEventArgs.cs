namespace TeamsMediaBot.Events
{
    /// <summary>
    /// Event arguments for audio data received from Teams.
    /// </summary>
    public class AudioDataEventArgs : EventArgs
    {
        /// <summary>
        /// Gets the raw audio data (PCM S16LE, 16kHz, mono).
        /// </summary>
        public byte[] AudioData { get; }

        /// <summary>
        /// Gets the timestamp when this audio was received.
        /// </summary>
        public DateTime Timestamp { get; }

        /// <summary>
        /// Initializes a new instance of the <see cref="AudioDataEventArgs"/> class.
        /// </summary>
        /// <param name="audioData">The raw audio data.</param>
        public AudioDataEventArgs(byte[] audioData)
        {
            AudioData = audioData;
            Timestamp = DateTime.UtcNow;
        }

        /// <summary>
        /// Initializes a new instance of the <see cref="AudioDataEventArgs"/> class.
        /// </summary>
        /// <param name="audioData">The raw audio data.</param>
        /// <param name="timestamp">The timestamp.</param>
        public AudioDataEventArgs(byte[] audioData, DateTime timestamp)
        {
            AudioData = audioData;
            Timestamp = timestamp;
        }
    }
}
