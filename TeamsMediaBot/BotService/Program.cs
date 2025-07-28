using BotService;
using BotService.Srt;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.Console(new Serilog.Formatting.Json.JsonFormatter())
    .CreateLogger();

builder.Host.UseSerilog();

builder.Services.AddSingleton<ISrtWriter, SrtWriter>();
builder.Services.AddSingleton<TeamsBot>();
builder.Services.AddControllers();

var app = builder.Build();

app.MapGet("/health", () => Results.Ok());
app.MapControllers();

app.Run();
