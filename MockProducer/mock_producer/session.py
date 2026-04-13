import httpx

from mock_producer.cli import Config


async def fetch_session(config: Config) -> dict:
    url = f"{config.session_api_url}/v1/sessions/{config.session_id}"
    async with httpx.AsyncClient() as http:
        r = await http.get(url, params={"withCaptions": "false"})
        r.raise_for_status()
        return r.json()
