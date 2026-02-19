const http = require("http")
const https = require("https")
const { URL } = require("url")
const { logger } = require("live-srt-lib")

module.exports = (webserver) => {
  const teamsAppServiceUrl = process.env.TEAMS_APP_SERVICE_URL

  return [
    {
      path: "/teams-app/download",
      method: "get",
      controller: async (req, res, next) => {
        if (!teamsAppServiceUrl) {
          return res
            .status(503)
            .json({ error: "Teams App Service is not configured" })
        }

        try {
          const targetUrl = new URL("/manifest/package.zip", teamsAppServiceUrl)
          const client = targetUrl.protocol === "https:" ? https : http

          const proxyReq = client.get(targetUrl.toString(), (proxyRes) => {
            if (proxyRes.statusCode !== 200) {
              return res
                .status(proxyRes.statusCode)
                .json({ error: "Failed to download Teams app package" })
            }

            res.setHeader(
              "Content-Type",
              "application/zip",
            )
            res.setHeader(
              "Content-Disposition",
              'attachment; filename="linto-teams-app.zip"',
            )

            if (proxyRes.headers["content-length"]) {
              res.setHeader("Content-Length", proxyRes.headers["content-length"])
            }

            proxyRes.pipe(res)
          })

          proxyReq.on("error", (err) => {
            logger.error("Error proxying Teams app download:", err)
            next(err)
          })
        } catch (err) {
          logger.error("Error in teams-app/download:", err)
          next(err)
        }
      },
    },
    {
      path: "/teams-app/info",
      method: "get",
      controller: async (req, res, next) => {
        if (!teamsAppServiceUrl) {
          return res
            .status(503)
            .json({ error: "Teams App Service is not configured" })
        }

        try {
          const targetUrl = new URL("/manifest/info", teamsAppServiceUrl)
          const client = targetUrl.protocol === "https:" ? https : http

          const proxyReq = client.get(targetUrl.toString(), (proxyRes) => {
            let data = ""
            proxyRes.on("data", (chunk) => {
              data += chunk
            })
            proxyRes.on("end", () => {
              try {
                res.status(proxyRes.statusCode).json(JSON.parse(data))
              } catch {
                res
                  .status(proxyRes.statusCode)
                  .json({ error: "Invalid response from Teams App Service" })
              }
            })
          })

          proxyReq.on("error", (err) => {
            logger.error("Error proxying Teams app info:", err)
            next(err)
          })
        } catch (err) {
          logger.error("Error in teams-app/info:", err)
          next(err)
        }
      },
    },
  ]
}
