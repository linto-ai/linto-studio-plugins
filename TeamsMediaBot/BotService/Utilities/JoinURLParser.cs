using System;
using System.Text.RegularExpressions;
using System.Web;

namespace BotService
{
    /// <summary>
    /// Teams meeting URL parser result
    /// </summary>
    public class MeetingInfo
    {
        public string TenantId { get; set; }
        public string MeetingId { get; set; }
        public string ThreadId { get; set; }
        public string MessageId { get; set; }
        public string JoinUrl { get; set; }
        public string OrganizerId { get; set; }
    }

    /// <summary>
    /// Utility to parse Teams meeting join URLs
    /// </summary>
    public static class JoinURLParser
    {
        /// <summary>
        /// Parse a Teams meeting join URL to extract meeting information
        /// </summary>
        /// <param name="joinUrl">The Teams meeting join URL</param>
        /// <returns>Meeting information</returns>
        public static MeetingInfo Parse(string joinUrl)
        {
            if (string.IsNullOrWhiteSpace(joinUrl))
                throw new ArgumentException("Join URL cannot be null or empty", nameof(joinUrl));

            var meetingInfo = new MeetingInfo
            {
                JoinUrl = joinUrl
            };

            try
            {
                var uri = new Uri(joinUrl);
                
                // Extract meeting ID from the URL path
                // For URLs like: https://teams.microsoft.com/meet/3900345535483?p=xwwGX0zmPqc4M95PeZ
                var pathSegments = uri.AbsolutePath.Split('/');
                if (pathSegments.Length > 2 && pathSegments[1] == "meet")
                {
                    meetingInfo.MeetingId = pathSegments[2];
                    meetingInfo.ThreadId = $"19:meeting_{meetingInfo.MeetingId}@thread.v2";
                    meetingInfo.MessageId = "0";
                    
                    // For public meetings, use a default tenant ID
                    meetingInfo.TenantId = "common";
                }
                else
                {
                    // For traditional meeting URLs with meetup-join format
                    // Extract meeting info from encoded URL segments
                    // URL format: /l/meetup-join/19%3ameeting_xxx%40thread.v2/0
                    
                    if (pathSegments.Length >= 4 && pathSegments[2] == "meetup-join")
                    {
                        // Extract the encoded thread ID from segment 3
                        var encodedThreadId = pathSegments[3];
                        var decodedThreadId = Uri.UnescapeDataString(encodedThreadId);
                        
                        meetingInfo.ThreadId = decodedThreadId;
                        
                        // Extract meeting ID from thread ID (between meeting_ and @thread.v2)
                        var meetingMatch = Regex.Match(decodedThreadId, @"meeting_([^@]+)");
                        if (meetingMatch.Success)
                        {
                            meetingInfo.MeetingId = meetingMatch.Groups[1].Value;
                        }
                        else
                        {
                            meetingInfo.MeetingId = decodedThreadId;
                        }
                        
                        // Message ID is usually the last segment
                        if (pathSegments.Length > 4)
                        {
                            meetingInfo.MessageId = pathSegments[4];
                        }
                    }
                    
                    // Extract tenant ID from context parameter
                    var query = HttpUtility.ParseQueryString(uri.Query);
                    var context = query["context"];
                    if (!string.IsNullOrEmpty(context))
                    {
                        var decodedContext = Uri.UnescapeDataString(context);
                        var tidMatch = Regex.Match(decodedContext, @"""Tid""\s*:\s*""([^""]+)""");
                        if (tidMatch.Success)
                        {
                            meetingInfo.TenantId = tidMatch.Groups[1].Value;
                        }
                        
                        // Extract organizer ID
                        var oidMatch = Regex.Match(decodedContext, @"""Oid""\s*:\s*""([^""]+)""");
                        if (oidMatch.Success)
                        {
                            meetingInfo.OrganizerId = oidMatch.Groups[1].Value;
                        }
                    }
                }
                
                // Default values if not found
                if (string.IsNullOrEmpty(meetingInfo.TenantId))
                    meetingInfo.TenantId = "common";
                if (string.IsNullOrEmpty(meetingInfo.MessageId))
                    meetingInfo.MessageId = "0";
                    
                return meetingInfo;
            }
            catch (Exception ex)
            {
                throw new ArgumentException($"Invalid Teams meeting URL: {ex.Message}", nameof(joinUrl), ex);
            }
        }
    }
}