// ***********************************************************************
// Assembly         : TeamsMediaBot.Services
// Author           : JasonTheDeveloper
// Created          : 09-07-2020
//
// Last Modified By : bcage29
// Last Modified On : 10-17-2023
// ***********************************************************************
// <copyright file="BotMediaStream.cs" company="Microsoft Corporation">
//     Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license.
// </copyright>
// <summary>The bot media stream.</summary>
// ***********************************************************************-
using TeamsMediaBot.Events;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Calls.Media;
using Microsoft.Graph.Communications.Common;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Skype.Bots.Media;
using System.Runtime.InteropServices;

namespace TeamsMediaBot.Bot
{
    /// <summary>
    /// Class responsible for streaming audio.
    /// </summary>
    public class BotMediaStream : ObjectRootDisposable
    {
        /// <summary>
        /// The participants
        /// </summary>
        internal List<IParticipant> participants;

        /// <summary>
        /// The audio socket
        /// </summary>
        private readonly IAudioSocket _audioSocket;

        private readonly ILogger _logger;
        private int shutdown;

        // Active speaker tracking from AudioMediaBuffer.ActiveSpeakers (per-frame, real-time)
        private uint _confirmedSpeakerMsi = uint.MaxValue;
        private uint _pendingSpeakerMsi = uint.MaxValue;
        private long _pendingSpeakerSinceTicks;
        private const int SpeakerDebounceMs = 200;
        private const int SilenceDebounceMs = 2000;

        /// <summary>
        /// Event raised when audio data is received from Teams.
        /// Used to stream audio to external consumers (e.g., Transcriber WebSocket).
        /// </summary>
        public event EventHandler<AudioDataEventArgs>? AudioDataReceived;

        /// <summary>
        /// Event raised when the active speaker MSI changes, detected from AudioMediaBuffer.ActiveSpeakers.
        /// More reliable and faster than SDK's DominantSpeakerChanged: real-time with 200ms debounce,
        /// works for all participant types including external/anonymous users.
        /// </summary>
        public event Action<uint>? ActiveSpeakerMsiChanged;

        /// <summary>
        /// Initializes a new instance of the <see cref="BotMediaStream" /> class.
        /// </summary>
        /// <param name="mediaSession">The media session.</param>
        /// <param name="callId">The call identity</param>
        /// <param name="graphLogger">The Graph logger.</param>
        /// <param name="logger">The logger.</param>
        /// <param name="settings">Azure settings</param>
        /// <exception cref="InvalidOperationException">A mediaSession needs to have at least an audioSocket</exception>
        public BotMediaStream(
            ILocalMediaSession mediaSession,
            string callId,
            IGraphLogger graphLogger,
            ILogger logger,
            AppSettings settings
        )
            : base(graphLogger)
        {
            if (mediaSession == null) throw new ArgumentNullException(nameof(mediaSession));
            if (logger == null) throw new ArgumentNullException(nameof(logger));

            _logger = logger;
            this.participants = new List<IParticipant>();

            // Subscribe to the audio media.
            this._audioSocket = mediaSession.AudioSocket;
            if (this._audioSocket == null)
            {
                throw new InvalidOperationException("A mediaSession needs to have at least an audioSocket");
            }

            this._audioSocket.AudioMediaReceived += this.OnAudioMediaReceived;
        }

        /// <summary>
        /// Gets the participants.
        /// </summary>
        /// <returns>List&lt;IParticipant&gt;.</returns>
        public List<IParticipant> GetParticipants()
        {
            return participants;
        }

        /// <summary>
        /// Shut down.
        /// </summary>
        /// <returns><see cref="Task" />.</returns>
        public Task ShutdownAsync()
        {
            if (Interlocked.CompareExchange(ref this.shutdown, 1, 1) == 1)
            {
                return Task.CompletedTask;
            }

            // unsubscribe
            if (this._audioSocket != null)
            {
                this._audioSocket.AudioMediaReceived -= this.OnAudioMediaReceived;
            }

            return Task.CompletedTask;
        }

        /// <summary>
        /// Receive audio from subscribed participant.
        /// </summary>
        /// <param name="sender">The sender.</param>
        /// <param name="e">The audio media received arguments.</param>
        private void OnAudioMediaReceived(object? sender, AudioMediaReceivedEventArgs e)
        {
            _logger.LogTrace($"Received Audio: [AudioMediaReceivedEventArgs(Data=<{e.Buffer.Data.ToString()}>, Length={e.Buffer.Length}, Timestamp={e.Buffer.Timestamp})]");

            try
            {
                // Detect active speaker from per-frame ActiveSpeakers array
                DetectActiveSpeaker(e.Buffer.ActiveSpeakers);

                // Extract audio data for external consumers
                var length = e.Buffer.Length;
                if (length > 0)
                {
                    var buffer = new byte[length];
                    Marshal.Copy(e.Buffer.Data, buffer, 0, (int)length);

                    // Emit audio data event for external streaming (e.g., to Transcriber)
                    AudioDataReceived?.Invoke(this, new AudioDataEventArgs(buffer));
                }
            }
            catch (Exception ex)
            {
                this.GraphLogger.Error(ex);
                _logger.LogError(ex, "OnAudioMediaReceived error");
            }
            finally
            {
                e.Buffer.Dispose();
            }
        }

        /// <summary>
        /// Detects active speaker changes from AudioMediaBuffer.ActiveSpeakers with debounce.
        /// A speaker change is confirmed only after the new MSI is stable for 200ms.
        /// </summary>
        private void DetectActiveSpeaker(uint[]? activeSpeakers)
        {
            uint currentMsi = (activeSpeakers != null && activeSpeakers.Length > 0)
                ? activeSpeakers[0]
                : uint.MaxValue;

            if (currentMsi != _pendingSpeakerMsi)
            {
                // New candidate speaker, start debounce
                _pendingSpeakerMsi = currentMsi;
                _pendingSpeakerSinceTicks = Environment.TickCount64;
            }
            else if (currentMsi != _confirmedSpeakerMsi)
            {
                var debounce = (currentMsi == uint.MaxValue) ? SilenceDebounceMs : SpeakerDebounceMs;
                if ((Environment.TickCount64 - _pendingSpeakerSinceTicks) >= debounce)
                {
                    _confirmedSpeakerMsi = currentMsi;
                    ActiveSpeakerMsiChanged?.Invoke(currentMsi);
                }
            }
        }
    }
}
