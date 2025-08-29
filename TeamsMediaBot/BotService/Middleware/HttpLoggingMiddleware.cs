using System;
using System.Diagnostics;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Web;
using Serilog;

namespace BotService.Middleware
{
    /// <summary>
    /// Middleware to log all HTTP requests
    /// </summary>
    public class HttpLoggingMiddleware : DelegatingHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var stopwatch = Stopwatch.StartNew();
            var requestMethod = request.Method.ToString();
            var requestUri = request.RequestUri?.PathAndQuery ?? "unknown";
            
            // Log incoming request
            Log.Information("HTTP {Method} {Uri} [Starting]", requestMethod, requestUri);
            
            try
            {
                var response = await base.SendAsync(request, cancellationToken);
                
                stopwatch.Stop();
                
                // Log response
                Log.Information("HTTP {Method} {Uri} => {StatusCode} ({Duration}ms)", 
                    requestMethod, 
                    requestUri, 
                    (int)response.StatusCode, 
                    stopwatch.ElapsedMilliseconds);
                
                return response;
            }
            catch (Exception ex)
            {
                stopwatch.Stop();
                
                // Log error
                Log.Error(ex, "HTTP {Method} {Uri} => ERROR ({Duration}ms)", 
                    requestMethod, 
                    requestUri, 
                    stopwatch.ElapsedMilliseconds);
                
                throw;
            }
        }
    }
    
    /// <summary>
    /// HTTP Module to log all requests at IIS level
    /// </summary>
    public class HttpLoggingModule : IHttpModule
    {
        public void Init(HttpApplication context)
        {
            context.BeginRequest += OnBeginRequest;
            context.EndRequest += OnEndRequest;
        }
        
        private void OnBeginRequest(object sender, EventArgs e)
        {
            var app = (HttpApplication)sender;
            var context = app.Context;
            
            // Store start time
            context.Items["RequestStartTime"] = DateTime.UtcNow;
            
            Log.Information("HTTP {Method} {Path}{Query} [Request Started]",
                context.Request.HttpMethod,
                context.Request.Path,
                string.IsNullOrEmpty(context.Request.QueryString.ToString()) ? "" : "?" + context.Request.QueryString);
        }
        
        private void OnEndRequest(object sender, EventArgs e)
        {
            var app = (HttpApplication)sender;
            var context = app.Context;
            
            var startTime = context.Items["RequestStartTime"] as DateTime?;
            var duration = startTime.HasValue ? (int)(DateTime.UtcNow - startTime.Value).TotalMilliseconds : -1;
            
            Log.Information("HTTP {Method} {Path}{Query} => {StatusCode} ({Duration}ms)",
                context.Request.HttpMethod,
                context.Request.Path,
                string.IsNullOrEmpty(context.Request.QueryString.ToString()) ? "" : "?" + context.Request.QueryString,
                context.Response.StatusCode,
                duration);
        }
        
        public void Dispose()
        {
        }
    }
}