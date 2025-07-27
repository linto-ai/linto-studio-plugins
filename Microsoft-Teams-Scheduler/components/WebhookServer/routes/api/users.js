const { Model } = require('live-srt-lib');

module.exports = (webServer) => [{
    path: '/users',
    method: 'get',
    controller: async (req, res, next) => {
        try {
            const users = await Model.MsTeamsUser.findAll();
            res.json(users);
        } catch (err) {
            next(err);
        }
    }
}, {
    path: '/users',
    method: 'post',
    controller: async (req, res, next) => {
        const { userId } = req.body || {};
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }
        try {
            await webServer.ensureSubscription(userId);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
        try {
            const user = await Model.MsTeamsUser.create({ userId });
            res.status(201).json(user);
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                res.status(409).json({ error: 'User already exists' });
            } else {
                res.status(500).json({ error: err.message });
            }
        }
    }
}, {
    path: '/users/:id',
    method: 'put',
    controller: async (req, res, next) => {
        const { userId } = req.body || {};
        if (!userId) {
            return res.status(400).json({ error: 'userId is required' });
        }
        const user = await Model.MsTeamsUser.findByPk(req.params.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        try {
            await webServer.ensureSubscription(userId);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
        try {
            user.userId = userId;
            await user.save();
            res.json(user);
        } catch (err) {
            if (err.name === 'SequelizeUniqueConstraintError') {
                res.status(409).json({ error: 'User already exists' });
            } else {
                res.status(500).json({ error: err.message });
            }
        }
    }
}, {
    path: '/users/:id',
    method: 'delete',
    controller: async (req, res, next) => {
        const user = await Model.MsTeamsUser.findByPk(req.params.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        await user.destroy();
        res.json({ success: true });
    }
}];
