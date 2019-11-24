import {ESIRequest} from "../index.js";

let ESI = new ESIRequest();

(async () => {
    // Make a request to an endpoint.
    let first = await ESI.request("/v1/universe/races/");
    // ESI should respond with a 200 status code.
    console.log(first.headers[":status"]);

    // Make a second request to the same endpoint, this time passing the response from the first request in the options object.
    // The library will use the ETag from the previous response to make a conditional request.
    let second = await ESI.request("/v1/universe/races/", {previous_response: first});
    // Being made immediately after the first request, the ETags should match, and ESI should respond with a 304 status code.
    console.log(second.headers[":status"]);
    // The library will reuse the previous response; both responses will have the same data object.
    return second.data === first.data;
})().then(console.log, console.error).finally(ESI.close);
