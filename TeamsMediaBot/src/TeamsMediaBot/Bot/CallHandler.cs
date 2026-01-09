using TeamsMediaBot.Util;
using Microsoft.Graph;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Calls.Media;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Communications.Resources;
using Microsoft.Graph.Models;
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
        }

        /// <inheritdoc/>
        protected override Task HeartbeatAsync(ElapsedEventArgs args)
        {
            return this.Call.KeepAliveAsync();
        }

        /// <inheritdoc />
        protected override void Dispose(bool disposing)
        {
            _logger.LogInformation("[CallHandler] Disposing CallHandler for call {CallId}", this.Call?.Id);
            base.Dispose(disposing);
            this.Call.OnUpdated -= this.CallOnUpdated;
            this.Call.Participants.OnUpdated -= this.ParticipantsOnUpdated;

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
            var resultCode = e.NewResource.ResultInfo?.Code;
            var resultMessage = e.NewResource.ResultInfo?.Message;
            var resultSubcode = e.NewResource.ResultInfo?.Subcode;

            _logger.LogInformation("[CallHandler] === CALL STATE CHANGE ===");
            _logger.LogInformation("[CallHandler] Call ID: {CallId}", sender.Id);
            _logger.LogInformation("[CallHandler] State: {OldState} -> {NewState}", oldState, newState);
            if (resultCode.HasValue)
            {
                _logger.LogInformation("[CallHandler] Result Code: {Code}, Subcode: {Subcode}",
                    resultCode, resultSubcode);
            }
            if (!string.IsNullOrEmpty(resultMessage))
            {
                _logger.LogInformation("[CallHandler] Result Message: {Message}", resultMessage);
            }

            GraphLogger.Info($"Call status updated to {newState} - {resultMessage}");

            if (oldState != newState && newState == CallState.Established)
            {
                _logger.LogInformation("[CallHandler] Call is now ESTABLISHED - bot is in the meeting");
            }

            if (oldState == CallState.Established && newState == CallState.Terminated)
            {
                _logger.LogWarning("[CallHandler] === CALL TERMINATED ===");
                _logger.LogWarning("[CallHandler] Bot was removed from the meeting");
                _logger.LogWarning("[CallHandler] Reason: {Message}", resultMessage ?? "unknown");

                if (BotMediaStream != null)
                {
                    _logger.LogInformation("[CallHandler] Shutting down BotMediaStream...");
                    await BotMediaStream.ShutdownAsync().ForgetAndLogExceptionAsync(GraphLogger);
                }
            }

            // Log other state transitions for debugging
            if (newState == CallState.Terminating)
            {
                _logger.LogWarning("[CallHandler] Call is TERMINATING - bot is being disconnected");
            }
            else if (newState == CallState.Establishing)
            {
                _logger.LogInformation("[CallHandler] Call is ESTABLISHING - connecting to meeting...");
            }
        }

        /// <summary>
        /// Creates the participant update json.
        /// </summary>
        /// <param name="participantId">The participant identifier.</param>
        /// <param name="participantDisplayName">Display name of the participant.</param>
        /// <returns>System.String.</returns>
        private string createParticipantUpdateJson(string participantId, string participantDisplayName = "")
        {
            if (participantDisplayName.Length == 0)
                return "{" + String.Format($"\"Id\": \"{participantId}\"") + "}";
            else
                return "{" + String.Format($"\"Id\": \"{participantId}\", \"DisplayName\": \"{participantDisplayName}\"") + "}";
        }

        /// <summary>
        /// Updates the participant.
        /// </summary>
        /// <param name="participants">The participants.</param>
        /// <param name="participant">The participant.</param>
        /// <param name="added">if set to <c>true</c> [added].</param>
        /// <param name="participantDisplayName">Display name of the participant.</param>
        /// <returns>System.String.</returns>
        private string updateParticipant(List<IParticipant> participants, IParticipant participant, bool added, string participantDisplayName = "")
        {
            if (added)
                participants.Add(participant);
            else
                participants.Remove(participant);
            return createParticipantUpdateJson(participant.Id, participantDisplayName);
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
                var json = string.Empty;

                // todo remove the cast with the new graph implementation,
                // for now we want the bot to only subscribe to "real" participants
                var participantDetails = participant.Resource.Info.Identity.User;

                if (participantDetails != null)
                {
                    json = updateParticipant(this.BotMediaStream.participants, participant, added, participantDetails.DisplayName);
                }
                else if (participant.Resource.Info.Identity.AdditionalData?.Count > 0)
                {
                    if (CheckParticipantIsUsable(participant))
                    {
                        json = updateParticipant(this.BotMediaStream.participants, participant, added);
                    }
                }
            }
        }

        /// <summary>
        /// Event fired when the participants collection has been updated.
        /// </summary>
        /// <param name="sender">Participants collection.</param>
        /// <param name="args">Event args containing added and removed participants.</param>
        public void ParticipantsOnUpdated(IParticipantCollection sender, CollectionEventArgs<IParticipant> args)
        {
            updateParticipants(args.AddedResources);
            updateParticipants(args.RemovedResources, false);
        }

        /// <summary>
        /// Checks the participant is usable.
        /// </summary>
        /// <param name="p">The p.</param>
        /// <returns><c>true</c> if XXXX, <c>false</c> otherwise.</returns>
        private bool CheckParticipantIsUsable(IParticipant p)
        {
            foreach (var i in p.Resource.Info.Identity.AdditionalData)
                if (i.Key != "applicationInstance" && i.Value is Identity)
                    return true;

            return false;
        }
    }
}

