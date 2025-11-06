const path = require('path')
const middlewares = require(path.join(__dirname, "../middlewares"))
const ifHasElse = (condition, ifHas, otherwise) => {
    return !condition ? otherwise() : ifHas()
}

class Router {
    constructor(webServer) {
        const routes = require('./routes.js')(webServer)
        for (let level in routes) {
            for (let path in routes[level]) {
                const route = routes[level][path]
                const method = route.method

                // Build middleware chain
                const middlewareChain = [middlewares.logger]

                // Add route-specific middleware if present
                if (route.middleware) {
                    if (Array.isArray(route.middleware)) {
                        middlewareChain.push(...route.middleware)
                    } else {
                        middlewareChain.push(route.middleware)
                    }
                }

                // Add controller(s)
                if (Array.isArray(route.controller)) {
                    middlewareChain.push(...Object.values(route.controller))
                } else {
                    middlewareChain.push(route.controller)
                }

                webServer.express[method](level + route.path, ...middlewareChain)
            }
        }
    }
}

module.exports = webServer => new Router(webServer)
