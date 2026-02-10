namespace TeamsMediaBot.Events
{
    public class DominantSpeakerEventArgs : EventArgs
    {
        public string? ParticipantId { get; }
        public string? DisplayName { get; }

        public DominantSpeakerEventArgs(string? participantId, string? displayName)
        {
            ParticipantId = participantId;
            DisplayName = displayName;
        }
    }
}
