using Serilog.Events;
using Serilog.Formatting;
using System;
using System.Globalization;
using System.IO;

namespace BotService.Logging
{
    public class HumanReadableFormatter : ITextFormatter
    {
        private static readonly string[] LevelAbbreviations = { "VRB", "DBG", "INF", "WRN", "ERR", "FTL" };
        private static readonly ConsoleColor[] LevelColors = 
        { 
            ConsoleColor.DarkGray,    // Verbose
            ConsoleColor.Gray,        // Debug
            ConsoleColor.White,       // Information
            ConsoleColor.Yellow,      // Warning
            ConsoleColor.Red,         // Error
            ConsoleColor.DarkRed      // Fatal
        };

        public void Format(LogEvent logEvent, TextWriter output)
        {
            // Format: [HH:mm:ss.fff LEVEL] Message {Properties} Exception
            
            // Time
            output.Write('[');
            output.Write(logEvent.Timestamp.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));
            output.Write(' ');
            
            // Level (colored in console)
            var levelIndex = (int)logEvent.Level;
            var levelAbbr = LevelAbbreviations[levelIndex];
            
            // Try to use console colors if output supports it
            var isConsole = output == Console.Out || output == Console.Error;
            if (isConsole && Environment.UserInteractive)
            {
                var originalColor = Console.ForegroundColor;
                Console.ForegroundColor = LevelColors[levelIndex];
                output.Write(levelAbbr);
                Console.ForegroundColor = originalColor;
            }
            else
            {
                output.Write(levelAbbr);
            }
            
            output.Write("] ");
            
            // Source context (if available)
            if (logEvent.Properties.TryGetValue("SourceContext", out var sourceContext))
            {
                var context = sourceContext.ToString().Trim('"');
                // Shorten the context to just the class name
                var lastDot = context.LastIndexOf('.');
                if (lastDot > 0 && lastDot < context.Length - 1)
                {
                    context = context.Substring(lastDot + 1);
                }
                output.Write(context);
                output.Write(": ");
            }
            
            // Message
            logEvent.RenderMessage(output);
            
            // Properties (excluding standard ones)
            var hasProperties = false;
            foreach (var property in logEvent.Properties)
            {
                if (property.Key == "SourceContext" || 
                    property.Key == "RequestId" || 
                    property.Key == "RequestPath" ||
                    property.Key == "SpanId" ||
                    property.Key == "TraceId" ||
                    property.Key == "ParentId")
                    continue;
                
                if (!hasProperties)
                {
                    output.Write(" [");
                    hasProperties = true;
                }
                else
                {
                    output.Write(", ");
                }
                
                output.Write(property.Key);
                output.Write('=');
                output.Write(property.Value);
            }
            
            if (hasProperties)
            {
                output.Write(']');
            }
            
            // Exception
            if (logEvent.Exception != null)
            {
                output.WriteLine();
                output.Write("  Exception: ");
                output.WriteLine(logEvent.Exception.GetType().Name);
                output.Write("  Message: ");
                output.WriteLine(logEvent.Exception.Message);
                
                if (logEvent.Level >= LogEventLevel.Error)
                {
                    output.WriteLine("  Stack trace:");
                    var stackLines = logEvent.Exception.StackTrace?.Split('\n') ?? Array.Empty<string>();
                    foreach (var line in stackLines)
                    {
                        output.Write("    ");
                        output.WriteLine(line.TrimEnd());
                    }
                }
            }
            
            output.WriteLine();
        }
    }
}