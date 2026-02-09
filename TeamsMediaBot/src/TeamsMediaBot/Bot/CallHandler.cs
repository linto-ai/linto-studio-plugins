using System.Collections.Concurrent;
using TeamsMediaBot.Events;
using TeamsMediaBot.Util;
using Microsoft.Graph;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Calls.Media;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Communications.Resources;
using Microsoft.Graph.Models;
using Microsoft.Skype.Bots.Media;
using System.Timers;

namespace TeamsMediaBot.Bot
{
    /// <summary>
    /// Call Handler Logic.
    /// </summary>
    public class CallHandler : HeartbeatHandler
    {
        /// <summary>
        /// Gets the call.
        /// </summary>
        /// <value>The call.</value>
        public ICall Call { get; }

        /// <summary>
        /// Gets the bot media stream.
        /// </summary>
        /// <value>The bot media stream.</value>
        public BotMediaStream BotMediaStream { get; private set; }

        private readonly ILogger _logger;
        private readonly ConcurrentDictionary<string, (string DisplayName, uint? Msi)> _participants = new();
        private readonly ConcurrentDictionary<uint, string> _msiToParticipantId = new();

        // Track all participants for empty meeting detection (including bots)
        private readonly ConcurrentDictionary<string, bool> _allParticipants = new(); // participantId -> isHuman
        private CancellationTokenSource? _emptyMeetingCts;
        private const int EmptyMeetingTimeoutSeconds = 60;
        private bool _disposing;

        public event EventHandler<ParticipantEventArgs>? ParticipantChanged;
        public event EventHandler<Events.DominantSpeakerEventArgs>? DominantSpeakerChanged;
        public event EventHandler? MeetingEmptyTimeout;

        /// <summary>
        /// Initializes a new instance of the <see cref="CallHandler" /> class.
        /// </summary>
        /// <param name="statefulCall">The stateful call.</param>
        /// <param name="settings">The settings.</param>
        /// <param name="logger"></param>
        public CallHandler(
            ICall statefulCall,
            AppSettings settings,
            ILogger logger
        )
            : base(TimeSpan.FromMinutes(10), statefulCall?.GraphLogger)
        {
            _logger = logger;
            this.Call = statefulCall;
            this.Call.OnUpdated += this.CallOnUpdated;
            this.Call.Participants.OnUpdated += this.ParticipantsOnUpdated;

            _logger.LogInformation("[CallHandler] Created for call {CallId}, threadId: {ThreadId}",
                statefulCall.Id, statefulCall.Resource?.ChatInfo?.ThreadId ?? "unknown");

            this.BotMediaStream = new BotMediaStream(this.Call.GetLocalMediaSession(), this.Call.Id, this.GraphLogger, logger, settings);
            this.BotMediaStream.DominantSpeakerChanged += this.OnDominantSpeakerChanged;
        }

        /// <inheritdoc/>
        protected override Task HeartbeatAsync(ElapsedEventArgs args)
        {
            return this.Call.KeepAliveAsync();
        }

        /// <inheritdoc />
        protected override void Dispose(bool disposing)
        {
            _disposing = true;
            _logger.LogInformation("[CallHandler] Disposing CallHandler for call {CallId}", this.Call?.Id);

            // Cancel empty meeting timer
            CancelEmptyMeetingTimer();

            base.Dispose(disposing);
            this.Call.OnUpdated -= this.CallOnUpdated;
            this.Call.Participants.OnUpdated -= this.ParticipantsOnUpdated;

            if (this.BotMediaStream != null)
            {
                this.BotMediaStream.DominantSpeakerChanged -= this.OnDominantSpeakerChanged;
            }

            this.BotMediaStream?.ShutdownAsync().ForgetAndLogExceptionAsync(this.GraphLogger);
            _logger.LogInformation("[CallHandler] CallHandler disposed");
        }

        /// <summary>
        /// Event fired when the call has been updated.
        /// </summary>
        /// <param name="sender">The call.</param>
        /// <param name="e">The event args containing call changes.</param>
        private async void CallOnUpdated(ICall sender, ResourceEventArgs<Call> e)
        {
            var oldState = e.OldResource.State;
            var newState = e.NewResource.State;
            var resultMessage = e.NewResource.ResultInfo?.Message;

            if (oldState == newState) return;

            _logger.LogInformation("[Call] {OldState} -> {NewState}", oldState, newState);
            GraphLogger.Info($"Call status updated to {newState} - {resultMessage}");

            if (newState == CallState.Terminated && BotMediaStream != null)
            {
                _logger.LogWarning("[Call] Terminated: {Reason}", resultMessage ?? "unknown");
                await BotMediaStream.ShutdownAsync().ForgetAndLogExceptionAsync(GraphLogger);
            }
        }

        /// <summary>
        /// Updates the participants.
        /// </summary>
        /// <param name="eventArgs">The event arguments.</param>
        /// <param name="added">if set to <c>true</c> [added].</param>
        private void updateParticipants(ICollection<IParticipant> eventArgs, bool added = true)
        {
            foreach (var participant in eventArgs)
            {
                var participantDetails = participant.Resource.Info.Identity.User;
                string? displayName = null;
                bool isUsable = false;

                if (participantDetails != null)
                {
                    displayName = participantDetails.DisplayName ?? "";
                    isUsable = true;
                }
                else if (participant.Resource.Info.Identity.AdditionalData?.Count > 0)
                {
                    isUsable = CheckParticipantIsUsable(participant);
                    if (isUsable)
                    {
                        foreach (var entry in participant.Resource.Info.Identity.AdditionalData)
                        {
                            if (entry.Key != "applicationInstance" && entry.Value is Identity identity)
                            {
                                displayName = identity.DisplayName ?? "";
                                break;
                            }
                        }
                    }
                }

                if (!isUsable) continue;

                displayName ??= "";
                var participantId = participant.Id;

                if (added)
                {
                    // Extract MSI from media streams
                    uint? msi = null;
                    try
                    {
                        var mediaStreams = participant.Resource.MediaStreams;
                        if (mediaStreams != null)
                        {
                            foreach (var ms in mediaStreams)
                            {
                                if (ms.MediaType == Modality.Audio && ms.SourceId != null)
                                {
                                    if (uint.TryParse(ms.SourceId, out var parsedMsi))
                                    {
                                        msi = parsedMsi;
                                        _msiToParticipantId[parsedMsi] = participantId;
                                        _logger.LogDebug("[Participant] MSI {Msi} -> {Name}", parsedMsi, displayName);
                                    }
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "[Participant] Error extracting MSI for {Id}", participantId);
                    }

                    _participants[participantId] = (displayName, msi);
                    _allParticipants[participantId] = true; // Mark as human (usable participants are humans)
                    this.BotMediaStream.participants.Add(participant);

                    _logger.LogInformation("[Participant] + {Name}", displayName);
                    ParticipantChanged?.Invoke(this, new ParticipantEventArgs(participantId, displayName, "join"));
                }
                else
                {
                    if (_participants.TryRemove(participantId, out var removed))
                    {
                        if (removed.Msi.HasValue)
                        {
                            _msiToParticipantId.TryRemove(removed.Msi.Value, out _);
                        }
                    }
                    _allParticipants.TryRemove(participantId, out _);
                    this.BotMediaStream.participants.Remove(participant);

                    _logger.LogInformation("[Participant] - {Name}", displayName);
                    ParticipantChanged?.Invoke(this, new ParticipantEventArgs(participantId, displayName, "leave"));
                }
            }

            // Check if meeting is now empty (no human participants)
            CheckEmptyMeeting();
        }

        /// <summary>
        /// Event fired when the participants collection has been updated.
        /// </summary>
        public void ParticipantsOnUpdated(IParticipantCollection sender, CollectionEventArgs<IParticipant> args)
        {
            updateParticipants(args.AddedResources);
            updateParticipants(args.RemovedResources, false);
        }

        private void OnDominantSpeakerChanged(object? sender, DominantSpeakerChangedEventArgs e)
        {
            try
            {
                var msi = e.CurrentDominantSpeaker;
                if (_msiToParticipantId.TryGetValue(msi, out var participantId))
                {
                    var displayName = "";
                    if (_participants.TryGetValue(participantId, out var info))
                    {
                        displayName = info.DisplayName;
                    }

                    _logger.LogInformation("[CallHandler] Dominant speaker: {Id} ({Name}) MSI={Msi}",
                        participantId, displayName, msi);
                    DominantSpeakerChanged?.Invoke(this, new Events.DominantSpeakerEventArgs(participantId, displayName));
                }
                else
                {
                    _logger.LogDebug("[Speaker] Unknown MSI {Msi}", msi);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[CallHandler] Error handling dominant speaker change");
            }
        }

        private bool CheckParticipantIsUsable(IParticipant p)
        {
            foreach (var i in p.Resource.Info.Identity.AdditionalData)
                if (i.Key != "applicationInstance" && i.Value is Identity)
                    return true;

            return false;
        }

        /// <summary>
        /// Checks if the meeting is empty (no human participants) and starts/cancels auto-leave timer accordingly.
        /// </summary>
        private void CheckEmptyMeeting()
        {
            // Don't start timer if we're already disposing
            if (_disposing) return;

            // Count human participants (those tracked in _allParticipants with value true)
            var humanCount = _allParticipants.Count(kvp => kvp.Value);

            if (humanCount == 0)
            {
                // No human participants, start timer if not already running
                if (_emptyMeetingCts == null)
                {
                    _logger.LogWarning("[CallHandler] Meeting empty, auto-leave in {Seconds}s", EmptyMeetingTimeoutSeconds);
                    StartEmptyMeetingTimer();
                }
            }
            else
            {
                // Human participants present, cancel timer if running
                if (_emptyMeetingCts != null)
                {
                    _logger.LogInformation("[CallHandler] Participant joined, cancelling auto-leave");
                    CancelEmptyMeetingTimer();
                }
            }
        }

        /// <summary>
        /// Starts the empty meeting timer that triggers auto-leave after timeout.
        /// </summary>
        private async void StartEmptyMeetingTimer()
        {
            _emptyMeetingCts = new CancellationTokenSource();
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(EmptyMeetingTimeoutSeconds), _emptyMeetingCts.Token);
                _logger.LogWarning("[CallHandler] Meeting empty timeout - triggering auto-leave");
                MeetingEmptyTimeout?.Invoke(this, EventArgs.Empty);
            }
            catch (OperationCanceledException)
            {
                _logger.LogInformation("[CallHandler] Auto-leave cancelled - participant joined");
            }
            finally
            {
                _emptyMeetingCts?.Dispose();
                _emptyMeetingCts = null;
            }
        }

        /// <summary>
        /// Cancels the empty meeting timer if running.
        /// </summary>
        private void CancelEmptyMeetingTimer()
        {
            if (_emptyMeetingCts != null)
            {
                _emptyMeetingCts.Cancel();
                _emptyMeetingCts.Dispose();
                _emptyMeetingCts = null;
            }
        }
    }
}

