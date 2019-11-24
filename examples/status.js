import {ESIRequest} from "../index.js";

// This ESI instance will keep retrying the request every 10 seconds, until the request succeeds.
let ESI = new ESIRequest({
    max_time: Infinity,
    max_retries: Infinity,
    retry_delay: function* () {
        while (true) yield 10000;
    }
});

let timeout = time => new Promise(resolve => setTimeout(resolve, time));

(async () => {
    while (true) {
        // Request the server status.
        // Due to the custom retry behaviour defined above, the library will be able to bridge the request through longer periods of unavailability, such as the daily downtime.
        let status = await ESI.request("/v1/status/");
        // Log the online player count.
        console.log(status.headers["last-modified"], status.data.players);
        // Wait for the cache on the endpoint to expire before making the request again.
        await timeout(Date.parse(status.headers["expires"]) - Date.parse(status.headers["date"]) + 500);
    }
})().catch(console.error).finally(ESI.close);