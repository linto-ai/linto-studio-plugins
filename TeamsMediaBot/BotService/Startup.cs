using System;
using System.Web.Http;
using Microsoft.Owin;
using Owin;
using Serilog;
using Serilog.Events;
using BotService.Logging;
using BotService.WebSocket;
using Microsoft.Extensions.DependencyInjection;
using System.Configuration;
using System.IO;
using Newtonsoft.Json.Linq;

[assembly: OwinStartup(typeof(BotService.Startup))]

namespace BotService
{
    public class Startup
    {
        public void Configuration(IAppBuilder app)
        {
            // Configure Serilog
            var logFormat = Environment.GetEnvironmentVariable("LOG_FORMAT")?.ToLowerInvariant() ?? "human";
            
            var loggerConfig = new LoggerConfiguration()
                .Enrich.FromLogContext()
                .MinimumLevel.Information();

            if (logFormat == "json")
            {
                loggerConfig.WriteTo.Console(new Serilog.Formatting.Json.JsonFormatter());
            }
            else
            {
                loggerConfig.WriteTo.Console(new HumanReadableFormatter());
            }

            Log.Logger = loggerConfig.CreateLogger();

            // Configure dependency injection
            var services = new ServiceCollection();
            ConfigureServices(services);
            
            // Configure Web API
            var config = new HttpConfiguration();
            
            // Setup DI container
            var serviceProvider = services.BuildServiceProvider();
            config.DependencyResolver = new ServiceProviderDependencyResolver(serviceProvider);
            
            // Configure routes
            config.MapHttpAttributeRoutes();
            config.Routes.MapHttpRoute(
                name: "DefaultApi",
                routeTemplate: "api/{controller}/{id}",
                defaults: new { id = RouteParameter.Optional }
            );

            app.UseWebApi(config);
            
            Log.Information("Teams Media Bot service started on .NET Framework 4.8");
        }

        private void ConfigureServices(IServiceCollection services)
        {
            // Load configuration
            var config = LoadConfiguration();
            
            services.AddSingleton<IConfiguration>(config);
            services.AddSingleton<IWebSocketAudioStreamer, WebSocketAudioStreamer>();
            
            // Add logging services
            services.AddLogging(builder =>
            {
                builder.AddSerilog();
            });
            
            services.AddSingleton<TeamsBot>();
            services.AddTransient<Controllers.BotController>();
            services.AddTransient<Controllers.CallbacksController>();
        }

        private IConfiguration LoadConfiguration()
        {
            var config = new Configuration();
            
            // Load from appsettings.json
            var basePath = AppDomain.CurrentDomain.BaseDirectory;
            var appSettingsPath = Path.Combine(basePath, "appsettings.json");
            if (File.Exists(appSettingsPath))
            {
                var json = File.ReadAllText(appSettingsPath);
                var jObject = JObject.Parse(json);
                LoadConfigFromJson(config, jObject);
            }
            
            // Load from appsettings.Development.json
            var devSettingsPath = Path.Combine(basePath, "appsettings.Development.json");
            if (File.Exists(devSettingsPath))
            {
                var json = File.ReadAllText(devSettingsPath);
                var jObject = JObject.Parse(json);
                LoadConfigFromJson(config, jObject);
            }
            
            // Load from appsettings.secrets.json
            var secretsPath = Path.Combine(basePath, "appsettings.secrets.json");
            if (File.Exists(secretsPath))
            {
                var json = File.ReadAllText(secretsPath);
                var jObject = JObject.Parse(json);
                LoadConfigFromJson(config, jObject);
            }
            
            // Also check environment variables
            foreach (var key in new[] { "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET" })
            {
                var value = Environment.GetEnvironmentVariable(key);
                if (!string.IsNullOrEmpty(value))
                {
                    config[key] = value;
                }
            }
            
            return config;
        }
        
        private void LoadConfigFromJson(Configuration config, JObject jObject)
        {
            foreach (var property in jObject.Properties())
            {
                if (property.Value.Type == JTokenType.String)
                {
                    config[property.Name] = property.Value.ToString();
                }
            }
        }
    }
    
    // Simple configuration implementation
    public interface IConfiguration
    {
        string this[string key] { get; }
    }
    
    public class Configuration : IConfiguration
    {
        private readonly System.Collections.Generic.Dictionary<string, string> _values = new System.Collections.Generic.Dictionary<string, string>();
        
        public string this[string key]
        {
            get => _values.TryGetValue(key, out var value) ? value : null;
            set => _values[key] = value;
        }
    }
}