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
            _logger.LogInformation("[PlatformCallController] Notification request received from {RemoteIp}",
                HttpContext.Connection.RemoteIpAddress);

            var httpRequestMessage = HttpHelpers.ToHttpRequestMessage(this.Request);

            // Pass the incoming notification to the sdk. The sdk takes care of what to do with it.
            var response = await _botService.Client.ProcessNotificationAsync(httpRequestMessage).ConfigureAwait(false);

            _logger.LogInformation("[PlatformCallController] Notification request processed with status {StatusCode}",
                response.StatusCode);

            return response;
        }
    }
}