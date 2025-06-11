const { Model, logger, Security } = require("live-srt-lib");

function keyIsEncrypted(profil, withKey, withSalt) {
  try {
    new Security({keyEnv: withKey, saltPath: withSalt}).decrypt(profil.config.key);
    return true;
  } catch {
    return false;
  }
}

async function migrateKeys(oldKey, oldSalt, newKey, newSalt) {
  const profiles = await Model.TranscriberProfile.findAll();
  for(const profil of profiles) {
    if (profil.config.key && keyIsEncrypted(profil, oldKey, oldSalt)) {
      logger.warn(`Encrypting key for Transcriber Profile ${profil.id}`)
      const rawKey = new Security({keyEnv: oldKey, saltPath: oldSalt}).decrypt(profil.config.key);
      profil.config.key = new Security({keyEnv: newKey, saltPath: newSalt}).encrypt(rawKey);
      await Model.TranscriberProfile.update({config: profil.config}, {where: {id: profil.id}});
    }
  }
}

function validateSecurityParams(params) {
  const requiredKeys = [
    'OLD_SECURITY_CRYPT_KEY',
    'NEW_SECURITY_CRYPT_KEY'
  ];

  const missing = requiredKeys.filter(
    key => !params[key] || params[key].trim() === ''
  );

  if (missing.length > 0) {
    throw new Error(`Missing or empty parameter(s): ${missing.join(', ')}`);
  }
}

const args = process.argv.slice(2);
const params = {};

args.forEach(arg => {
    const [key, value] = arg.split('=');
    params[key] = value;
});

validateSecurityParams(params);

const saltOrNull = val => val?.trim() || null;

migrateKeys(
  params.OLD_SECURITY_CRYPT_KEY,
  saltOrNull(params.OLD_SECURITY_SALT_FILEPATH),
  params.NEW_SECURITY_CRYPT_KEY,
  saltOrNull(params.NEW_SECURITY_SALT_FILEPATH)
)
