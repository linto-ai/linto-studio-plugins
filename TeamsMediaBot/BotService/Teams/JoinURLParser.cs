using System;
using System.Text.RegularExpressions;
using System.Web;

namespace BotService.Teams
{
    public class MeetingInfo
    {
        public string ThreadId { get; set; }
        public string TenantId { get; set; }
        public string MeetingId { get; set; }
        public string MessageId { get; set; }
    }
    
    public static class JoinURLParser
    {
        public static MeetingInfo Parse(string joinUrl)
        {
            try
            {
                var uri = new Uri(joinUrl);
                
                // Handle thread ID passed directly (workaround for new URLs)
                if (joinUrl.Contains("19:meeting_") && joinUrl.Contains("@thread.v2"))
                {
                    var threadIdMatch = Regex.Match(joinUrl, @"(19:meeting_[^/\?&]+@thread\.v2)");
                    if (threadIdMatch.Success)
                    {
                        return new MeetingInfo
                        {
                            ThreadId = Uri.UnescapeDataString(threadIdMatch.Groups[1].Value),
                            TenantId = ExtractTenantId(uri),
                            MeetingId = ExtractMeetingId(threadIdMatch.Groups[1].Value),
                            MessageId = "0"
                        };
                    }
                }
                
                // Handle old format URLs
                if (uri.AbsolutePath.Contains("/l/meetup-join/"))
                {
                    var segments = uri.AbsolutePath.Split('/');
                    if (segments.Length > 3)
                    {
                        var threadId = Uri.UnescapeDataString(segments[3]);
                        return new MeetingInfo
                        {
                            ThreadId = threadId,
                            TenantId = ExtractTenantId(uri),
                            MeetingId = ExtractMeetingId(threadId),
                            MessageId = "0"
                        };
                    }
                }
                
                throw new ArgumentException($"Unable to parse meeting URL: {joinUrl}");
            }
            catch (Exception ex)
            {
                throw new ArgumentException($"Invalid Teams meeting URL: {joinUrl}", ex);
            }
        }
        
        private static string ExtractTenantId(Uri uri)
        {
            try
            {
                var query = HttpUtility.ParseQueryString(uri.Query);
                var context = query["context"];
                if (!string.IsNullOrEmpty(context))
                {
                    var contextObj = Newtonsoft.Json.JsonConvert.DeserializeObject<dynamic>(Uri.UnescapeDataString(context));
                    return contextObj?.Tid?.ToString();
                }
            }
            catch
            {
                // Ignore parsing errors
            }
            
            return "unknown-tenant";
        }
        
        private static string ExtractMeetingId(string threadId)
        {
            // Extract meeting ID from thread ID format: 19:meeting_<meetingId>@thread.v2
            var match = Regex.Match(threadId, @"19:meeting_([^@]+)@thread\.v2");
            return match.Success ? match.Groups[1].Value : "unknown-meeting";
        }
    }
}