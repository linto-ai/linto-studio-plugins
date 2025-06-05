const { Model, logger, Security } = require("live-srt-lib");

function keyIsEncrypted(profil) {
  try {
    new Security().decrypt(profil.config.key);
    return true;
  } catch {
    return false;
  }
}

function encryptKey(profil) {
  profil.config.key = new Security().encrypt(profil.config.key);
}

async function encrypt_keys() {
  const profiles = await Model.TranscriberProfile.findAll();
  for(const profil of profiles) {
    if (profil.config.key && !keyIsEncrypted(profil)) {
      logger.warn(`Encrypting key for Transcriber Profile ${profil.id}`)
      encryptKey(profil);
      await Model.TranscriberProfile.update({config: profil.config}, {where: {id: profil.id}});
    }
  }
}

module.exports.encrypt_keys = encrypt_keys;
