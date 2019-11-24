import {ESIRequest} from "../index.js";

// Getting all the market orders from ESI is a big task, and as done below, will involve making hundreds of concurrent requests to ESI.
// With the default settings, this might take a while, as a single connection can only handle 128 concurrent requests.
// Using a connection pool gets around this.
let ESI = new ESIRequest({
    pool_size: 15
});

(async () => {
    // Request the list of region IDs.
    let regions = await ESI.request("/v1/universe/regions/").data;
    // Request the market orders for each of the regions.
    console.time("markets");
    let markets = await Promise.all(regions.map(region_id => ESI.request("/v1/markets/{region_id}/orders/", {parameters: {region_id}}).data));
    console.timeEnd("markets");
    // Merge all the orders into a single array.
    let market_orders = markets.flat();
    // Just return how many of them there are in total.
    return market_orders.length;
})().then(console.log, console.error).finally(ESI.close);
