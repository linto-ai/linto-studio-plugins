FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY BotService/bin/Release/net8.0/publish/ .
ENTRYPOINT ["dotnet", "BotService.dll"]
