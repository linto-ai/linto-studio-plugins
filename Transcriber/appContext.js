const { v4: uuidv4 } = require('uuid');

const APP_ID = uuidv4();

function getAppId() {
  return APP_ID;
}

module.exports = { getAppId };
