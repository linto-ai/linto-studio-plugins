const { Model, logger, Security } = require("live-srt-lib");

async function encryptKeys(withKey, withSalt) {
  const profiles = await Model.TranscriberProfile.findAll();
  for(const profil of profiles) {
    if (profil.config.key) {
      logger.warn(`Encrypting key for Transcriber Profile ${profil.id}`)
      profil.config.key = new Security({keyEnv: withKey, saltPath: withSalt}).encrypt(profil.config.key);
      await Model.TranscriberProfile.update({config: profil.config}, {where: {id: profil.id}});
    }
  }
}

function validateSecurityParams(params) {
  const requiredKeys = [
    'SECURITY_CRYPT_KEY'
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

encryptKeys(
  params.SECURITY_CRYPT_KEY,
  saltOrNull(params.SECURITY_SALT_FILEPATH)
)
