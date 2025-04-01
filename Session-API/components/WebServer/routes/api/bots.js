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
        path: '/bots/:id',
        method: 'get',
        controller: async (req, res, next) => {
            const { id } = req.params;
            try {
                const bot = await Model.Bot.findByPk(id);
                if (!bot) {
                    return res.status(404).send('Bot not found');
                }
                res.json(bot);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/bots',
        method: 'get',
        controller: async (req, res, next) => {
            const limit = req.query.limit ?? 10
            const offset = req.query.offset ?? 0
            const channelId = req.query.channelId

            let where = {}
            if (channelId) {
                where.channelId = channelId;
            }

            try {
                const results = await Model.Bot.findAndCountAll({
                    limit: limit,
                    offset: offset,
                    where: where
                });

                res.json({
                    bots: results.rows,
                    totalItems: results.count
                });
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/bots',
        method: 'post',
        controller: async (req, res, next) => {
            try {
                const { url, channelId, provider, async: botAsync} = req.body;
                if (!url || channelId === undefined || !provider) {
                    return res.status(400).json({ error: "url, channelId, and provider are required" });
                }
                const channel = await Model.Channel.findByPk(channelId);
                if (!channel) {
                    return res.status(404).json({ error: "Channel not found" });
                }
                // Check if the channel's streamStatus is 'inactive'
                if (channel.streamStatus !== 'inactive') {
                    return res.status(400).json({ error: "The channel must be inactive to start a bot" });
                }

                // Set default value for live
                const enableDisplaySub = req.body.enableDisplaySub;
                const subSource = req.body.subSource;

                // Check at least compressAudio or live
                if (channel.compressAudio && !channel.enableLiveTranscripts) {
                    return res.status(400).json({ error: "Compress audio must be disabled if live is disabled." });
                }

                const bot = await Model.Bot.create({
                    url, provider, enableDisplaySub,
                    subSource, channelId: channel.id
                });

                webserver.emit('startbot', bot.id);
                res.json(bot);
            } catch (err) {
                next(err);
            }
        }
    }, {
        path: '/bots/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            try {
                const { id } = req.params;

                if (!id) {
                    return res.status(400).json({ error: "botId is required" });
                }

                const bot = await Model.Bot.findByPk(id)

                if (!bot) {
                    return res.status(404).json({ error: "Bot not found" });
                }

                // The bot will be deleted in DB by the scheduler
                webserver.emit('stopbot', id);
                res.json({ success: true });
            } catch (err) {
                next(err);
            }
        }
    }];
};
