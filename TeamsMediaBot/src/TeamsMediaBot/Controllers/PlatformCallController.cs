// ***********************************************************************
// Assembly         : TeamsMediaBot.Controllers
// Author           : JasonTheDeveloper
// Created          : 09-07-2020
//
// Last Modified By : bcage29
// Last Modified On : 02-28-2022
// ***********************************************************************
// <copyright file="PlatformCallController.cs" company="Microsoft">
//     Copyright ©  2023
// </copyright>
// <summary></summary>
// ***********************************************************************>
using TeamsMediaBot.Bot;
using TeamsMediaBot.Constants;
using TeamsMediaBot.Util;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;
using Microsoft.Graph.Communications.Client;

namespace TeamsMediaBot.Controllers
{
    /// <summary>
    /// Entry point for handling call-related web hook requests from Skype Platform.
    /// </summary>
    [ApiController]
    [Route(HttpRouteConstants.CallSignalingRoutePrefix)]
    public class PlatformCallController : ControllerBase
    {
        private readonly ILogger<PlatformCallController> _logger;
        private readonly AppSettings _settings;
        private readonly IBotService _botService;

        public PlatformCallController(ILogger<PlatformCallController> logger,
            IOptions<AppSettings> settings,
            IBotService botService)
        {
            _logger = logger;
            _settings = settings.Value;
            _botService = botService;
        }

        /// <summary>
        /// Handle a callback for an incoming call.
        /// </summary>
        /// <returns>The <see cref="HttpResponseMessage" />.</returns>
        [HttpPost]
        [Route(HttpRouteConstants.OnIncomingRequestRoute)]
        public async Task<HttpResponseMessage> OnIncomingRequestAsync()
        {
            _logger.LogInformation("[PlatformCallController] Incoming call request received from {RemoteIp}",
                HttpContext.Connection.RemoteIpAddress);

            var httpRequestMessage = HttpHelpers.ToHttpRequestMessage(this.Request);
            var response = await _botService.Client.ProcessNotificationAsync(httpRequestMessage).ConfigureAwait(false);

            _logger.LogInformation("[PlatformCallController] Incoming call request processed with status {StatusCode}",
                response.StatusCode);

            return response;
        }

        /// <summary>
        /// Handle a callback for an existing call
        /// </summary>
        /// <returns>The <see cref="HttpResponseMessage" />.</returns>
        [HttpPost]
        [Route(HttpRouteConstants.OnNotificationRequestRoute)]
        public async Task<HttpResponseMessage> OnNotificationRequestAsync()
        {
            // Copy body to memory so we can read it for logging and still pass it to SDK
            var memoryStream = new MemoryStream();
            await Request.Body.CopyToAsync(memoryStream);
            memoryStream.Position = 0;

            // Log notification details
            try
            {
                using var reader = new StreamReader(memoryStream, leaveOpen: true);
                var body = await reader.ReadToEndAsync();
                memoryStream.Position = 0;

                using var doc = System.Text.Json.JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("value", out var valueArray) && valueArray.GetArrayLength() > 0)
                {
                    var first = valueArray[0];
                    var changeType = first.TryGetProperty("changeType", out var ct) ? ct.GetString() : "?";
                    var resourceUrl = first.TryGetProperty("resourceUrl", out var ru) ? ru.GetString() ?? "" : "";

                    // Extract call ID from resourceUrl (format: /communications/calls/{callId}/...)
                    var callId = "";
                    var parts = resourceUrl.Split('/');
                    var callsIndex = Array.IndexOf(parts, "calls");
                    if (callsIndex >= 0 && callsIndex + 1 < parts.Length)
                    {
                        callId = parts[callsIndex + 1].Split('?')[0]; // Remove query params
                        if (callId.Length > 8) callId = callId[..8]; // Truncate for readability
                    }

                    // Determine resource type and extract relevant info
                    var info = "";
                    if (resourceUrl.Contains("/participants"))
                    {
                        if (first.TryGetProperty("resourceData", out var rd))
                        {
                            var displayName = "";
                            if (rd.TryGetProperty("info", out var infoObj) &&
                                infoObj.TryGetProperty("identity", out var identity) &&
                                identity.TryGetProperty("user", out var user) &&
                                user.TryGetProperty("displayName", out var dn))
                            {
                                displayName = dn.GetString() ?? "";
                            }
                            var state = rd.TryGetProperty("state", out var st) ? st.GetString() : "";
                            info = $"participant {displayName} {state}".Trim();
                        }
                        else
                        {
                            info = "participant";
                        }
                    }
                    else if (resourceUrl.Contains("/calls"))
                    {
                        if (first.TryGetProperty("resourceData", out var rd) && rd.TryGetProperty("state", out var st))
                        {
                            info = $"call {st.GetString()}";
                        }
                        else
                        {
                            info = "call";
                        }
                    }
                    else
                    {
                        info = resourceUrl.Split('/').LastOrDefault(s => !string.IsNullOrEmpty(s)) ?? "unknown";
                    }

                    _logger.LogInformation("[Notification] [{CallId}] {ChangeType} {Info}", callId, changeType, info);
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "[Notification] Parse error");
            }

            // Replace request body with our memory stream copy
            Request.Body = memoryStream;

            var httpRequestMessage = HttpHelpers.ToHttpRequestMessage(this.Request);
            var response = await _botService.Client.ProcessNotificationAsync(httpRequestMessage).ConfigureAwait(false);

            return response;
        }
    }
}