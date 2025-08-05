using System;
using System.Web;

namespace BotService
{
    public class Global : HttpApplication
    {
        protected void Application_Start()
        {
            // OWIN startup will be handled by the Startup class
        }
        
        protected void Application_Error()
        {
            var exception = Server.GetLastError();
            if (exception != null)
            {
                Serilog.Log.Error(exception, "Unhandled application error");
            }
        }
    }
}