const TranslationProvider = require('./base');

class TranslateGemmaProvider extends TranslationProvider {
    constructor(config) {
        super(config);
        this.endpoint = config.endpoint || process.env.TRANSLATEGEMMA_ENDPOINT;
        if (!this.endpoint) {
            throw new Error('TRANSLATEGEMMA_ENDPOINT is required (e.g. http://host:8000)');
        }
        this.model = config.model || process.env.TRANSLATEGEMMA_MODEL || 'Infomaniak-AI/vllm-translategemma-4b-it';
        this.maxTokens = config.maxTokens || parseInt(process.env.TRANSLATEGEMMA_MAX_TOKENS || '500');
    }

    async translate(text, sourceLang, targetLang) {
        // TranslateGemma uses short codes (fr, en, de) not BCP-47 (fr-FR)
        const src = sourceLang.split('-')[0];
        const tgt = targetLang.split('-')[0];

        const prompt = `<<<source>>>${src}<<<target>>>${tgt}<<<text>>>${text}`;

        const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: this.maxTokens,
            }),
        });

        if (!res.ok) {
            throw new Error(`TranslateGemma API error: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        return data.choices[0].message.content.trim();
    }
}

module.exports = TranslateGemmaProvider;
