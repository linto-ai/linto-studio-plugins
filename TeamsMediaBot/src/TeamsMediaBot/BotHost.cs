// ***********************************************************************
// Assembly         : TeamsMediaBot
// Author           : bcage29
// Created          : 10-27-2023
//
// Last Modified By : bcage29
// Last Modified On : 10-27-2023
// ***********************************************************************
// <copyright file="BotHost.cs" company="Microsoft">
//     Copyright ©  2023
// </copyright>
// <summary></summary>
// ***********************************************************************
using DotNetEnv.Configuration;
using TeamsMediaBot.Bot;
using TeamsMediaBot.Services.Mqtt;
using TeamsMediaBot.Services.Orchestration;
using TeamsMediaBot.Util;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Graph.Communications.Common.Telemetry;

namespace TeamsMediaBot
{
    /// <summary>
    /// Bot Web Application.
    /// </summary>
    public class BotHost : IBotHost
    {
        private readonly ILogger<BotHost> _logger;
        private WebApplication? _app;
        private IBotOrchestratorService? _orchestrator;
        private IBotService? _botService;

        /// <summary>
        /// Bot Host constructor
        /// </summary>
        /// <param name="logger"></param>
        public BotHost(ILogger<BotHost> logger)
        {
            _logger = logger;
        }

        /// <summary>
        /// Starting the Bot and Web App
        /// </summary>
        /// <returns></returns>
        public async Task StartAsync()
        {
            _logger.LogInformation("Starting the Teams Media Bot");
            // Set up the bot web application
            var builder = WebApplication.CreateBuilder();

            if (builder.Environment.IsDevelopment())
            {
                // load the .env file environment variables
                builder.Configuration.AddDotNetEnv();
            }

            // Add Environment Variables
            builder.Configuration.AddEnvironmentVariables(prefix: "AppSettings__");

            // Add services to the container.
            builder.Services.AddControllers();

            // Learn more about configuring Swagger/OpenAPI at https://aka.ms/aspnetcore/swashbuckle
            builder.Services.AddEndpointsApiExplorer();
            builder.Services.AddSwaggerGen();

            var section = builder.Configuration.GetSection("AppSettings");
            var appSettings = section.Get<AppSettings>();

            builder.Services
                .AddOptions<AppSettings>()
                .BindConfiguration(nameof(AppSettings))
                .ValidateDataAnnotations()
                .ValidateOnStart();

            builder.Services.AddSingleton<IGraphLogger, GraphLogger>(_ => new GraphLogger("TeamsMediaBotWorker", redirectToTrace: true));
            builder.Services.AddSingleton<IBotMediaLogger, BotMediaLogger>();
            builder.Logging.ClearProviders();
            builder.Logging.AddSimpleConsole(options =>
            {
                options.SingleLine = true;
                options.TimestampFormat = "HH:mm:ss ";
                options.IncludeScopes = false;
            });
            builder.Logging.SetMinimumLevel(LogLevel.Information);

            builder.Services.AddSingleton<IBotService, BotService>();

            // MQTT and Orchestrator services
            builder.Services.AddSingleton<IMqttService, MqttService>();
            builder.Services.AddSingleton<IBotOrchestratorService, BotOrchestratorService>();

            // Bot Settings Setup
            var botInternalHostingProtocol = "https";
            if (appSettings.UseLocalDevSettings)
            {
                // if running locally with ngrok
                // the call signalling and notification will use the same internal and external ports
                // because you cannot receive requests on the same tunnel with different ports

                // calls come in over 443 (external) and route to the internally hosted port: BotCallingInternalPort
                botInternalHostingProtocol = "http";

                builder.Services.PostConfigure<AppSettings>(options =>
                {
                    options.BotInstanceExternalPort = 443;
                    options.BotInternalPort = appSettings.BotCallingInternalPort;

                });
            }
            else
            {
                //appSettings.MediaDnsName = appSettings.ServiceDnsName;
                builder.Services.PostConfigure<AppSettings>(options =>
                {
                    options.MediaDnsName = appSettings.ServiceDnsName;
                });
            }

            // localhost
            var baseDomain = "+";

            // http for local development
            // https for running on VM
            var callListeningUris = new HashSet<string>
            {
                $"{botInternalHostingProtocol}://{baseDomain}:{appSettings.BotCallingInternalPort}/",
                $"{botInternalHostingProtocol}://{baseDomain}:{appSettings.BotInternalPort}/",
                $"{botInternalHostingProtocol}://{baseDomain}:{appSettings.BotInstanceExternalPort}/"
            };

            builder.WebHost.UseUrls(callListeningUris.ToArray());

            builder.WebHost.ConfigureKestrel(serverOptions =>
            {
                serverOptions.ConfigureHttpsDefaults(listenOptions =>
                {
                    listenOptions.ServerCertificate = Utilities.GetCertificateFromStore(appSettings.CertificateThumbprint);
                });
            });

            _app = builder.Build();

            // Get singleton services and store references for shutdown
            _botService = _app.Services.GetRequiredService<IBotService>();
            _botService.Initialize();

            // Initialize the bot orchestrator (MQTT connection and command handling)
            _orchestrator = _app.Services.GetRequiredService<IBotOrchestratorService>();
            await _orchestrator.InitializeAsync();

            // Configure the HTTP request pipeline.
            if (_app.Environment.IsDevelopment())
            {
                // https://localhost:<port>/swagger
                _app.UseSwagger();
                _app.UseSwaggerUI();
            }

            _app.UseAuthorization();

            _app.MapControllers();

            await _app.RunAsync();
        }

        /// <summary>
        /// Stop the bot web application
        /// </summary>
        /// <returns></returns>
        public async Task StopAsync()
        {
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));

                // Shutdown the orchestrator first (stops all managed bots)
                if (_orchestrator != null)
                {
                    await _orchestrator.ShutdownAsync();
                }

                // Terminate all calls and dispose of the call client
                if (_botService != null)
                {
                    await _botService.Shutdown();
                }

                // Stop the bot web application
                if (_app != null)
                {
                    await _app.StopAsync(cts.Token);
                }
            }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("Shutdown timeout, forcing exit");
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Error during shutdown: {Message}", ex.Message);
            }
        }
    }
}
