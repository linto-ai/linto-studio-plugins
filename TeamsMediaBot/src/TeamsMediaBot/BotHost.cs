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
    /// Bot Web Application with integrated SignalR hub for live captions.
    /// </summary>
    public class BotHost : IBotHost
    {
        private readonly ILogger<BotHost> _logger;
        private WebApplication? _app;

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

            // Add SignalR for real-time captions
            builder.Services.AddSignalR(options =>
            {
                options.EnableDetailedErrors = builder.Environment.IsDevelopment();
                options.KeepAliveInterval = TimeSpan.FromSeconds(15);
                options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
            });

            // Add CORS for Teams app
            builder.Services.AddCors(options =>
            {
                options.AddPolicy("TeamsCorsPolicy", policy =>
                {
                    policy.AllowAnyHeader()
                          .AllowAnyMethod()
                          .AllowCredentials()
                          .SetIsOriginAllowed(_ => true);
                });
            });

            var section = builder.Configuration.GetSection("AppSettings");
            var appSettings = section.Get<AppSettings>();

            builder.Services
                .AddOptions<AppSettings>()
                .BindConfiguration(nameof(AppSettings))
                .ValidateDataAnnotations()
                .ValidateOnStart();

            builder.Services.AddSingleton<IGraphLogger, GraphLogger>(_ => new GraphLogger("TeamsMediaBotWorker", redirectToTrace: true));
            builder.Services.AddSingleton<IBotMediaLogger, BotMediaLogger>();
            builder.Logging.AddApplicationInsights();
            builder.Logging.SetMinimumLevel(LogLevel.Information);

            builder.Logging.AddEventLog(config => config.SourceName = "Teams Media Bot Service");

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
                $"{botInternalHostingProtocol}://{baseDomain}:{appSettings.BotInternalPort}/"
                // Port 443 temporairement retiré pour test
                // $"{botInternalHostingProtocol}://{baseDomain}:{appSettings.BotInstanceExternalPort}/"
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

            using (var scope = _app.Services.CreateScope())
            {
                var bot = scope.ServiceProvider.GetRequiredService<IBotService>();
                bot.Initialize();

                // Initialize the bot orchestrator (MQTT connection and command handling)
                var orchestrator = scope.ServiceProvider.GetRequiredService<IBotOrchestratorService>();
                await orchestrator.InitializeAsync();
            }

            // Configure the HTTP request pipeline.
            if (_app.Environment.IsDevelopment())
            {
                // https://localhost:<port>/swagger
                _app.UseSwagger();
                _app.UseSwaggerUI();
            }

            _app.UseAuthorization();

            // Enable CORS for Teams app
            _app.UseCors("TeamsCorsPolicy");

            // Serve static files (React app in wwwroot)
            _app.UseDefaultFiles();
            _app.UseStaticFiles();

            _app.MapControllers();

            await _app.RunAsync();
        }

        /// <summary>
        /// Stop the bot web application
        /// </summary>
        /// <returns></returns>
        public async Task StopAsync()
        {
            if (_app != null)
            {
                using (var scope = _app.Services.CreateScope())
                {
                    // Shutdown the orchestrator first (stops all managed bots)
                    var orchestrator = scope.ServiceProvider.GetRequiredService<IBotOrchestratorService>();
                    await orchestrator.ShutdownAsync();

                    var bot = scope.ServiceProvider.GetRequiredService<IBotService>();
                    // terminate all calls and dispose of the call client
                    await bot.Shutdown();
                }

                // stop the bot web application
                await _app.StopAsync();
            }
        }
    }
}
