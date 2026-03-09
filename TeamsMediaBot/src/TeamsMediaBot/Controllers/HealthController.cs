// ***********************************************************************
// Assembly         : TeamsMediaBot.Controllers
// Author           : bcage29
// Created          : 10-27-2023
//
// Last Modified By : bcage29
// Last Modified On : 02-28-2022
// ***********************************************************************
// <copyright file="HealthController.cs" company="Microsoft">
//     Copyright ©  2023
// </copyright>
// <summary></summary>
// ***********************************************************************
using Microsoft.AspNetCore.Mvc;
using System.Net;
using TeamsMediaBot.Services.Certificate;

namespace TeamsMediaBot.Controllers
{

    [Route("[controller]")]
    [ApiController]
    public class HealthController : ControllerBase
    {
        private readonly ILogger<HealthController> _logger;
        private readonly ICertificateManager? _certManager;

        public HealthController(ILogger<HealthController> logger, ICertificateManager? certManager = null)
        {
            _logger = logger;
            _certManager = certManager;
        }

        /// <summary>
        /// Health check endpoint.
        /// </summary>
        /// <returns></returns>
        [HttpGet]
        public IActionResult Get()
        {
            try
            {
                _logger.LogInformation("HEALTH CALL");
                return Ok(new
                {
                    status = "ok",
                    certExpiry = _certManager?.CertificateExpiry?.ToString("o"),
                    certThumbprint = _certManager?.CurrentThumbprint
                });
            }
            catch (Exception e)
            {
                _logger.LogError(e, $"Received HTTP {this.Request.Method}, {this.Request.Path}");

                return Problem(detail: e.StackTrace, statusCode: (int)HttpStatusCode.InternalServerError, title: e.Message);
            }
        }
    }
}
