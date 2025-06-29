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
                webServer.express[method](
                    level + route.path,
                    middlewares.logger,
                    ifHasElse(
                        Array.isArray(route.controller),
                        () => Object.values(route.controller),
                        () => route.controller
                    )
                )
            }
        }
    }
}

module.exports = webServer => new Router(webServer)
