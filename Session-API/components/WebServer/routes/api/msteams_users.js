const axios = require('axios');

module.exports = (webserver) => {
    const base = process.env.MSTEAMS_SCHEDULER_PUBLIC_BASE || 'http://localhost:8081';

    return [{
        path: '/msteams/users',
        method: 'get',
        controller: async (req, res, next) => {
            try {
                const response = await axios.get(`${base}/users`);
                res.status(response.status).json(response.data);
            } catch (err) {
                if (err.response) {
                    return res.status(err.response.status).json({ error: err.response.data.error || err.response.data });
                }
                next(err);
            }
        }
    }, {
        path: '/msteams/users',
        method: 'post',
        controller: async (req, res, next) => {
            const { userId } = req.body || {};
            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }
            try {
                const response = await axios.post(`${base}/users`, { userId });
                res.status(response.status).json(response.data);
            } catch (err) {
                if (err.response) {
                    return res.status(err.response.status).json({ error: err.response.data.error || err.response.data });
                }
                next(err);
            }
        }
    }, {
        path: '/msteams/users/:id',
        method: 'put',
        controller: async (req, res, next) => {
            const { userId } = req.body || {};
            if (!userId) {
                return res.status(400).json({ error: 'userId is required' });
            }
            try {
                const response = await axios.put(`${base}/users/${req.params.id}`, { userId });
                res.status(response.status).json(response.data);
            } catch (err) {
                if (err.response) {
                    return res.status(err.response.status).json({ error: err.response.data.error || err.response.data });
                }
                next(err);
            }
        }
    }, {
        path: '/msteams/users/:id',
        method: 'delete',
        controller: async (req, res, next) => {
            try {
                const response = await axios.delete(`${base}/users/${req.params.id}`);
                res.status(response.status).json(response.data);
            } catch (err) {
                if (err.response) {
                    return res.status(err.response.status).json({ error: err.response.data.error || err.response.data });
                }
                next(err);
            }
        }
    }];
};
