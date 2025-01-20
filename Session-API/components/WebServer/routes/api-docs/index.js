const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./swagger/swagger.json');
const swaggerJsdoc = require("swagger-jsdoc")

const sessionBasePath = process.env.SESSION_API_BASE_PATH || ''

function forwardedPrefixMiddleware(req, res, next) {
    req.originalUrl = (req.headers['x-forwarded-prefix'] || '') + req.originalUrl
    next()
}

module.exports = (webserver) => {

    swaggerDocument.definition.servers = [{"url": process.env.SESSION_API_HOST + sessionBasePath + "/v1"}]
    swaggerDocument.definition.components = {
        ...swaggerDocument.definition.components,
        ...require('./swagger/components/index.js')
    }

    swaggerDocument.definition.components.schemas = {
        ...swaggerDocument.definition.components.schemas,
        ...require(`./swagger/components/schemas/index.js`)
    }
    swaggerDocument.definition.paths = require('./swagger/index.js')

    swaggerDocument.apis = ["./swagger/"]

    //serve swagger
    webserver.express.use('/api-docs/', forwardedPrefixMiddleware, swaggerUi.serve, swaggerUi.setup(swaggerJsdoc(swaggerDocument)));
}

