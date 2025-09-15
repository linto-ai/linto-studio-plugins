using System;
using System.Text.RegularExpressions;
using System.Web;
using Newtonsoft.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Graph;

namespace BotService.Teams
{
    /// <summary>
    /// Utility class to parse Microsoft Teams meeting join URLs
    /// Based on Microsoft Graph Communications SDK samples
    /// </summary>
    public class JoinInfo
    {
        private static readonly ILogger _logger = LoggerFactory.Create(builder => builder.AddConsole()).CreateLogger<JoinInfo>();
        
        // Regex patterns for Teams meeting URLs - based on Microsoft samples
        private static readonly Regex ThreadIdPattern = new Regex(@"19[%:]([a-zA-Z0-9@_\-\.]+)", RegexOptions.Compiled);
        private static readonly Regex MessageIdPattern = new Regex(@"\/(\d+)\?", RegexOptions.Compiled);
        private static readonly Regex ConferenceIdPattern = new Regex(@"conf[iI]d=(\d+)", RegexOptions.Compiled);
        
        public string ThreadId { get; set; }
        public string MessageId { get; set; }
        public string TenantId { get; set; }
        public string OrganizerId { get; set; }
        public string ConferenceId { get; set; }
        public bool IsVideoTeleconference { get; set; }

        /// <summary>
        /// Parse a Teams meeting join URL to extract meeting information
        /// </summary>
        /// <param name="joinUrl">Teams meeting join URL</param>
        /// <returns>Parsed join information</returns>
        public static JoinInfo Parse(string joinUrl)
        {
            if (string.IsNullOrWhiteSpace(joinUrl))
                throw new ArgumentException("Join URL cannot be null or empty", nameof(joinUrl));

            var joinInfo = new JoinInfo();
            
            try
            {
                _logger.LogInformation("Parsing Teams meeting URL: {JoinUrl}", joinUrl);
                
                var uri = new Uri(joinUrl);
                
                // Extract thread ID (meeting chat ID)
                var threadMatch = ThreadIdPattern.Match(joinUrl);
                if (threadMatch.Success)
                {
                    // URL decode the thread ID
                    joinInfo.ThreadId = Uri.UnescapeDataString(threadMatch.Value);
                    _logger.LogInformation("Extracted ThreadId: {ThreadId}", joinInfo.ThreadId);
                }
                else
                {
                    _logger.LogWarning("Could not extract ThreadId from URL");
                }

                // Extract message ID
                var messageMatch = MessageIdPattern.Match(joinUrl);
                if (messageMatch.Success)
                {
                    joinInfo.MessageId = messageMatch.Groups[1].Value;
                    _logger.LogInformation("Extracted MessageId: {MessageId}", joinInfo.MessageId);
                }

                // Check if this is a Video Teleconference (VTC) meeting
                var conferenceMatch = ConferenceIdPattern.Match(joinUrl);
                if (conferenceMatch.Success)
                {
                    joinInfo.ConferenceId = conferenceMatch.Groups[1].Value;
                    joinInfo.IsVideoTeleconference = true;
                    _logger.LogInformation("Detected Video Teleconference with ID: {ConferenceId}", joinInfo.ConferenceId);
                }

                // Extract context information from query parameters
                var query = HttpUtility.ParseQueryString(uri.Query);
                var context = query["context"];
                
                if (!string.IsNullOrEmpty(context))
                {
                    try
                    {
                        // Decode and parse the context JSON
                        var decodedContext = Uri.UnescapeDataString(context);
                        var contextData = JsonConvert.DeserializeObject<dynamic>(decodedContext);
                        
                        joinInfo.TenantId = contextData?.Tid?.ToString();
                        joinInfo.OrganizerId = contextData?.Oid?.ToString();
                        
                        _logger.LogInformation("Extracted from context - TenantId: {TenantId}, OrganizerId: {OrganizerId}", 
                            joinInfo.TenantId, joinInfo.OrganizerId);
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "Failed to parse context data from URL");
                    }
                }

                // Validate required fields
                if (string.IsNullOrEmpty(joinInfo.ThreadId) && string.IsNullOrEmpty(joinInfo.ConferenceId))
                {
                    throw new InvalidOperationException("Unable to extract ThreadId or ConferenceId from meeting URL");
                }

                _logger.LogInformation("✅ Successfully parsed Teams meeting URL");
                return joinInfo;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to parse Teams meeting URL: {JoinUrl}", joinUrl);
                throw new ArgumentException($"Invalid Teams meeting URL: {ex.Message}", nameof(joinUrl), ex);
            }
        }

        /// <summary>
        /// Create ChatInfo object for the Communications SDK
        /// </summary>
        /// <returns>ChatInfo for the meeting</returns>
        public ChatInfo ToChatInfo()
        {
            if (IsVideoTeleconference && !string.IsNullOrEmpty(ConferenceId))
            {
                // For VTC meetings, use the conference ID
                return new ChatInfo
                {
                    ThreadId = ConferenceId,
                    MessageId = "0" // Default for VTC
                };
            }
            else if (!string.IsNullOrEmpty(ThreadId))
            {
                // For regular Teams meetings
                return new ChatInfo
                {
                    ThreadId = ThreadId,
                    MessageId = MessageId ?? "0"
                };
            }
            
            throw new InvalidOperationException("Cannot create ChatInfo - missing ThreadId or ConferenceId");
        }

        /// <summary>
        /// Create MeetingInfo object for the Communications SDK
        /// </summary>
        /// <returns>MeetingInfo for the meeting</returns>
        public MeetingInfo ToMeetingInfo()
        {
            // For both regular and VTC meetings, we can use OrganizerMeetingInfo if we have organizer info
            if (!string.IsNullOrEmpty(TenantId) && !string.IsNullOrEmpty(OrganizerId))
            {
                return new OrganizerMeetingInfo
                {
                    Organizer = new IdentitySet
                    {
                        User = new Identity
                        {
                            Id = OrganizerId
                        }
                    }
                };
            }
            
            // Fallback to null - Teams will resolve from ChatInfo
            return null;
        }

        public override string ToString()
        {
            return $"JoinInfo(ThreadId: {ThreadId}, MessageId: {MessageId}, TenantId: {TenantId}, OrganizerId: {OrganizerId}, ConferenceId: {ConferenceId}, IsVTC: {IsVideoTeleconference})";
        }
    }
}