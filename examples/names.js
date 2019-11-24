import {ESIRequest} from "../index.js";

let ESI = new ESIRequest();

(async () => {
    // Request the list of type IDs.
    let types = await ESI.request("/v1/universe/types/");
    // Pass the list of type IDs to the /universe/names/ endpoint.
    let names = await ESI.request("/v3/universe/names/", {
        method: "POST",
        body: types.data,
        // The /universe/names/ endpoint will only accept 1000 IDs per request.
        // This option informs the library of that, making it split the request body over multiple requests.
        body_page_size: 1000
    });
    // Find the entry for type Carbon and return its ID.
    let carbon = names.data.find(type => type.name === "Carbon");
    return carbon.id;
})().then(console.log, console.error).finally(ESI.close);
