const helpers = require("../utils/helpers");

function legacyLogin(email, password) {
  const id = helpers.generateId();
  return { id, email, loggedIn: true };
}

function legacyLogout(sessionId) {
  return { loggedOut: true };
}

module.exports = {
  legacyLogin,
  legacyLogout,
};
