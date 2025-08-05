using System;
using Microsoft.Owin.Hosting;
using Serilog;

namespace BotService
{
    class Program
    {
        static void Main(string[] args)
        {
            var logFormat = Environment.GetEnvironmentVariable("LOG_FORMAT") ?? "human";
            
            if (logFormat.ToLower() == "json")
            {
                Log.Logger = new LoggerConfiguration()
                    .WriteTo.Console(new Serilog.Formatting.Json.JsonFormatter())
                    .CreateLogger();
            }
            else
            {
                Log.Logger = new LoggerConfiguration()
                    .WriteTo.Console(outputTemplate: "[{Timestamp:HH:mm:ss.fff} {Level:u3}] {Message:lj}{NewLine}{Exception}")
                    .CreateLogger();
            }

            string baseAddress = "http://localhost:5113/";

            try
            {
                Log.Information("🚀 Starting Teams Media Bot service...");
                Log.Information("Communications SDK: .NET Framework 4.8 - SUPPORTED");
                
                using (WebApp.Start<Startup>(url: baseAddress))
                {
                    Log.Information("✅ Service running on {BaseAddress}", baseAddress);
                    Log.Information("Health check: {HealthUrl}", baseAddress + "health");
                    Log.Information("Bot API: {ApiUrl}", baseAddress + "api/bot/");
                    Log.Information("Press [Enter] to stop the service");

                    Console.ReadLine();
                }
            }
            catch (Exception ex)
            {
                Log.Fatal(ex, "❌ Service startup failed");
                throw;
            }
            finally
            {
                Log.CloseAndFlush();
            }
        }
    }
}