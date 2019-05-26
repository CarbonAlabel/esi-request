const ESIRequest = require("../index.js");

// Getting all the market orders from ESI is a big task, and as done below, will involve making hundreds of concurrent requests to ESI.
// With the default memory limit of 10, the http2 session would run out of memory.
let ESI = new ESIRequest({
    connection_settings: {
        http2_options: {
            maxSessionMemory: 50
        }
    }
});

(async () => {
    // Request the list of region IDs.
    let regions = await ESI.request("/v1/universe/regions/");
    // Request the market orders for each of the regions.
    let markets = await Promise.all(regions.data.map(id => ESI.request(`/v1/markets/${id}/orders/`)));
    // Merge all the orders into a single array.
    let market_orders = markets.map(response => response.data).flat();
    // Just return how many of them there are in total.
    return market_orders.length;
})().then(console.log, console.error).finally(ESI.close);
