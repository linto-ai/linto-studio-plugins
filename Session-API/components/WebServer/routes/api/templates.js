const debug = require('debug')('session-api:router:api:sessions')
const { Model } = require("live-srt-lib")
const bcp47 = require('language-tags');
class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

module.exports = (webserver) => {
    return [
    {
        path: '/templates/:id',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const sessionTemplate = await Model.SessionTemplate.findByPk(req.params.id, {
                    include: {
                        model: Model.ChannelTemplate,
                        order: [['id', 'ASC']],
                        attributes: {
                            exclude: ['sessionTemplateId']
                        }
                    }
                });
                if (!sessionTemplate) {
                    return res.status(404).send('Session template not found');
                }
                res.json(sessionTemplate);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/templates',
        method: 'get',
        controller: async (req, res, next) => {
            const limit = req.query.limit ?? 10
            const offset = req.query.offset ?? 0

            try {
                const results = await Model.SessionTemplate.findAndCountAll({
                    limit: limit,
                    offset: offset,
                    include: {
                        model: Model.ChannelTemplate,
                        attributes: {
                            exclude: ['sessionTemplateId']
                        },
                        order: [['id', 'ASC']]
                    },
                });

                res.json({
                    sessionTemplates: results.rows,
                    totalItems: results.count
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/templates',
        method: 'post',
        controller: async (req, res, next) => {
            const channels = req.body.channels
            if (!channels || channels.length == 0) {
                return res.status(400).json({ "error": "At least one channel is required in the template" })
            }
            const transaction = await Model.sequelize.transaction();
            try {
                const sessionTemplate = await Model.SessionTemplate.create({
                    name: req.body.name || `New template ${new Date().toISOString()}`,
                    owner: req.body.owner || null,
                    organizationId: req.body.organizationId || null,
                    visibility: req.body.visibility || 'private',
                    autoStart: req.body.autoStart || false,
                    autoEnd: req.body.autoEnd || false,
                    meta: req.body.meta || null
                }, { transaction });
                // Create channel templates
                for (const channel of channels) {
                    if (channel.translations) {
                        if (!Array.isArray(channel.translations) || !channel.translations.every(bcp47.check)) {
                            throw new ApiError(400, "Channel translations must be an array of bcp47 strings");
                        }
                    }
                    let transcriberProfile = await Model.TranscriberProfile.findByPk(channel.transcriberProfileId, { transaction });
                    if (!transcriberProfile) {
                        throw new ApiError(400, `Transcriber profile with id ${channel.transcriberProfileId} not found`);
                    }
                    const languages = transcriberProfile.config.languages.map(language => language.candidate)
                    const translations = channel.translations
                    await Model.ChannelTemplate.create({
                        keepAudio: channel.keepAudio || false,
                        diarization: channel.diarization || false,
                        languages: languages,
                        translations: translations,
                        sessionTemplateId: sessionTemplate.id,
                        transcriberProfileId: transcriberProfile.id,
                        name: channel.name
                    }, { transaction });
                }
                await transaction.commit();

                // return the session with channels
                debug('Session template created', sessionTemplate.id);
                res.json(await Model.SessionTemplate.findByPk(sessionTemplate.id, {
                    include: {
                        model: Model.ChannelTemplate,
                        order: [['id', 'ASC']],
                        attributes: {
                            exclude: ['sessionTemplateId']
                        }
                    }
                }));
            } catch (err) {
                debug(err);
                await transaction.rollback();
                return next(err)
            }
        }
    }, {
        path: '/templates/:id',
        method: 'put',
        controller: async (req, res, next) => {
            const sessionTemplateId = req.params.id;

            const sessionTemplate = await Model.SessionTemplate.findByPk(sessionTemplateId);
            if (!sessionTemplate) {
                return res.status(404).json({ "error": `Session template ${sessionTemplateId} not found` });
            }

            const { channels: channels, ...templateAttributes } = req.body;

            if (!channels || channels.length == 0) {
                return res.status(400).json({ "error": "At least one channel is required in the template" })
            }

            const transaction = await Model.sequelize.transaction();
            try {
                await Model.SessionTemplate.update(templateAttributes, {
                    transaction,
                    where: {id: sessionTemplate.id}
                });

                // Delete existing channels
                await Model.ChannelTemplate.destroy({
                    where: {
                        sessionTemplateId: sessionTemplate.id
                    }
                }, { transaction });

                // Recreate channels
                for (const channel of channels) {
                    if (channel.translations) {
                        if (!Array.isArray(channel.translations) || !channel.translations.every(bcp47.check)) {
                            throw new ApiError(400, "Channel translations must be an array of bcp47 strings");
                        }
                    }
                    let transcriberProfile = await Model.TranscriberProfile.findByPk(channel.transcriberProfileId, { transaction });
                    if (!transcriberProfile) {
                        throw new ApiError(400, `Transcriber profile with id ${channel.transcriberProfileId} not found`);
                    }
                    const languages = transcriberProfile.config.languages.map(language => language.candidate)
                    const translations = channel.translations
                    await Model.ChannelTemplate.create({
                        keepAudio: channel.keepAudio || false,
                        diarization: channel.diarization || false,
                        languages: languages,
                        translations: translations,
                        sessionTemplateId: sessionTemplate.id,
                        transcriberProfileId: transcriberProfile.id,
                        name: channel.name
                    }, { transaction });
                }
                await transaction.commit();

                // return the session with channels
                debug('Session template created', sessionTemplate.id);
                res.json(await Model.SessionTemplate.findByPk(sessionTemplate.id, {
                    include: {
                        model: Model.ChannelTemplate,
                        order: [['id', 'ASC']],
                        attributes: {
                            exclude: ['sessionTemplateId']
                        }
                    }
                }));
            } catch (err) {
                debug(err);
                await transaction.rollback();
                return next(err)
            }
        }
    }, {
        path: '/templates/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            try {
                const sessionTemplate = await Model.SessionTemplate.findByPk(req.params.id);
                if (!sessionTemplate) {
                    return res.status(404).send('Session template not found');
                }
                await sessionTemplate.destroy();
                debug('Session template deleted', sessionTemplate.id);
                res.json({ 'success': true });
            } catch (err) {
                next(err);
            }
        }
    }];
};
