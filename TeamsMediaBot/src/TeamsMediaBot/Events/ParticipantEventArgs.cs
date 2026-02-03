namespace TeamsMediaBot.Events
{
    public class ParticipantEventArgs : EventArgs
    {
        public string ParticipantId { get; }
        public string DisplayName { get; }
        public string Action { get; }

        public ParticipantEventArgs(string participantId, string displayName, string action)
        {
            ParticipantId = participantId;
            DisplayName = displayName;
            Action = action;
        }
    }
}
