using BotService;
using BotService.Srt;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// Load secrets file if it exists (for development)
var env = builder.Environment;
if (env.IsDevelopment())
{
    var secretsPath = Path.Combine(env.ContentRootPath, "appsettings.secrets.json");
    if (File.Exists(secretsPath))
    {
        builder.Configuration.AddJsonFile(secretsPath, optional: true, reloadOnChange: true);
    }
}

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.Console(new Serilog.Formatting.Json.JsonFormatter())
    .CreateLogger();

builder.Host.UseSerilog();

builder.Services.AddSingleton<ISrtWriter, SrtWriter>();
builder.Services.AddSingleton<TeamsBot>();
builder.Services.AddSingleton<IConfiguration>(provider => builder.Configuration);
builder.Services.AddControllers();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok());
app.MapControllers();

app.Run();
