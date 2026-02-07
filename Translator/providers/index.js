const path = require('path');
const fs = require('fs');

function loadProvider(name) {
    const providerPath = path.join(__dirname, `${name}.js`);
    if (!fs.existsSync(providerPath)) {
        throw new Error(`No translation provider named '${name}' in '${providerPath}'`);
    }
    return require(providerPath);
}

module.exports = { loadProvider };
