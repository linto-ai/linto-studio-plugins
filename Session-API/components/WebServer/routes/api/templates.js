const { Model, logger } = require("live-srt-lib")
const { ApiError, validateTranslations, resolveTranscriberProfile } = require('./translationHelpers');

function parseBoolean(v) {
    if (v === "true" || v === true) {
        return true;
    }
    if (v === "false" || v === false) {
        return false;
    }
    return null;
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
                        attributes: {
                            exclude: ['sessionTemplateId']
                        }
                    },
                    order: [[Model.ChannelTemplate, 'id', 'ASC']]
                });
                if (!sessionTemplate) {
                    return res.status(404).json({ error: 'Session template not found' });
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
            const searchName = req.query.searchName
            const organizationId = req.query.organizationId;
            const visibility = req.query.visibility;
            const autoStart = parseBoolean(req.query.autoStart);
            const autoEnd = parseBoolean(req.query.autoEnd);

            let where = {}

            if (searchName) {
                where.name = { [Model.Op.startsWith]: searchName }
            }

            if (organizationId) {
                where.organizationId = organizationId;
            }

            if (visibility) {
                where.visibility = visibility;
            }

            if (typeof autoStart === 'boolean') {
                where.autoStart = autoStart;
            }

            if (typeof autoEnd === 'boolean') {
                where.autoEnd = autoEnd;
            }

            try {
                const results = await Model.SessionTemplate.findAndCountAll({
                    limit: limit,
                    offset: offset,
                    include: {
                        model: Model.ChannelTemplate,
                        attributes: {
                            exclude: ['sessionTemplateId']
                        }
                    },
                    where: where,
                    order: [[Model.ChannelTemplate, 'id', 'ASC']]
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
                    const translations = validateTranslations(channel.translations);
                    const transcriberProfile = await resolveTranscriberProfile(channel.transcriberProfileId, transaction);
                    const languages = transcriberProfile ? transcriberProfile.config.languages.map(language => language.candidate) : []
                    await Model.ChannelTemplate.create({
                        keepAudio: channel.keepAudio ?? true,
                        diarization: channel.diarization ?? false,
                        // No profile (audio-only): uncompressed audio + live off (quality invariant, see bots.js).
                        compressAudio: transcriberProfile ? (channel.compressAudio ?? true) : false,
                        enableLiveTranscripts: transcriberProfile ? (channel.enableLiveTranscripts ?? true) : false,
                        languages: languages,
                        translations: translations,
                        sessionTemplateId: sessionTemplate.id,
                        transcriberProfileId: transcriberProfile ? transcriberProfile.id : null,
                        name: channel.name,
                        meta: channel.meta
                    }, { transaction });
                }
                await transaction.commit();

                // return the session with channels
                logger.debug('Session template created', sessionTemplate.id);
                res.json(await Model.SessionTemplate.findByPk(sessionTemplate.id, {
                    include: {
                        model: Model.ChannelTemplate,
                        attributes: {
                            exclude: ['sessionTemplateId']
                        }
                    },
                    order: [[Model.ChannelTemplate, 'id', 'ASC']]
                }));
            } catch (err) {
                logger.debug(err);
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
                    const translations = validateTranslations(channel.translations);
                    const transcriberProfile = await resolveTranscriberProfile(channel.transcriberProfileId, transaction);
                    const languages = transcriberProfile ? transcriberProfile.config.languages.map(language => language.candidate) : []
                    await Model.ChannelTemplate.create({
                        keepAudio: channel.keepAudio ?? true,
                        diarization: channel.diarization ?? false,
                        // No profile (audio-only): uncompressed audio + live off (quality invariant, see bots.js).
                        compressAudio: transcriberProfile ? (channel.compressAudio ?? true) : false,
                        enableLiveTranscripts: transcriberProfile ? (channel.enableLiveTranscripts ?? true) : false,
                        languages: languages,
                        translations: translations,
                        sessionTemplateId: sessionTemplate.id,
                        transcriberProfileId: transcriberProfile ? transcriberProfile.id : null,
                        name: channel.name,
                        meta: channel.meta
                    }, { transaction });
                }
                await transaction.commit();

                // return the session with channels
                logger.debug('Session template created', sessionTemplate.id);
                res.json(await Model.SessionTemplate.findByPk(sessionTemplate.id, {
                    include: {
                        model: Model.ChannelTemplate,
                        attributes: {
                            exclude: ['sessionTemplateId']
                        }
                    },
                    order: [[Model.ChannelTemplate, 'id', 'ASC']]
                }));
            } catch (err) {
                logger.debug(err);
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
                    return res.status(404).json({ error: 'Session template not found' });
                }
                await sessionTemplate.destroy();
                logger.debug('Session template deleted', sessionTemplate.id);
                res.json({ 'success': true });
            } catch (err) {
                next(err);
            }
        }
    }];
};
